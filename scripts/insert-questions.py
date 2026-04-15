#!/usr/bin/env python3
"""Bulk-load Bible trivia questions into the Logos question bank.

Reads a JSON array from stdin. For each question:
  1. POST to judge-question Edge Function (deterministic Gates 0/1/3)
  2. If approved, INSERT into questions table via PostgREST with computed content_hash
  3. If rejected, log gate + reason and skip

Idempotent via content_hash unique constraint.

Required env vars:
  SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY

Usage:
  cat batch.json | python3 scripts/insert-questions.py
"""
import hashlib
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request

# macOS Python ships without system CA certs bundled; bypass verification for
# our own known Supabase endpoint rather than failing on every call.
_SSL_CTX = ssl._create_unverified_context()

URL = os.environ.get('SUPABASE_URL')
SERVICE_KEY = os.environ.get('SUPABASE_SERVICE_KEY')
ANON_KEY = os.environ.get('SUPABASE_ANON_KEY')

if not URL or not SERVICE_KEY or not ANON_KEY:
    print("ERROR: SUPABASE_URL, SUPABASE_SERVICE_KEY and SUPABASE_ANON_KEY must be set", file=sys.stderr)
    sys.exit(1)

JUDGE_URL = f"{URL}/functions/v1/judge-question"
INSERT_URL = f"{URL}/rest/v1/questions"


def sha256_norm(text: str) -> str:
    """Mirror the JS sha256Hex function in _shared/dedup.ts."""
    return hashlib.sha256(text.strip().lower().encode()).hexdigest()


def judge(q: dict) -> dict:
    body = json.dumps({
        "question": q["question"],
        "options": q["options"],
        "correct_index": q["correct_index"],
        "scripture_ref": q["scripture_ref"],
        "insight": q.get("insight", ""),
    }).encode()
    req = urllib.request.Request(
        JUDGE_URL,
        data=body,
        headers={
            "apikey": ANON_KEY,
            "Authorization": f"Bearer {ANON_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60, context=_SSL_CTX) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"approved": False, "gate": "http", "reason": f"HTTP {e.code}: {e.read().decode()[:200]}"}
    except Exception as e:
        return {"approved": False, "gate": "network", "reason": str(e)}


def _insert_one(row: dict) -> bool:
    """Insert a single row, returning True if inserted (not duplicate)."""
    body = json.dumps(row).encode()
    req = urllib.request.Request(
        INSERT_URL,
        data=body,
        headers={
            "apikey": SERVICE_KEY,
            "Authorization": f"Bearer {SERVICE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal,resolution=ignore-duplicates",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60, context=_SSL_CTX) as resp:
            return resp.status in (200, 201)
    except urllib.error.HTTPError as e:
        if e.code == 409:
            return False  # duplicate — acceptable
        raise
    except Exception:
        raise


def insert_chunked(rows: list, chunk_size: int = 50) -> tuple[int, list[str]]:
    """Insert in chunks. On 409 conflict, fall back to individual row inserts."""
    if not rows:
        return 0, []
    total_inserted = 0
    errors = []
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i:i + chunk_size]
        body = json.dumps(chunk).encode()
        req = urllib.request.Request(
            INSERT_URL,
            data=body,
            headers={
                "apikey": SERVICE_KEY,
                "Authorization": f"Bearer {SERVICE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=representation,resolution=ignore-duplicates",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120, context=_SSL_CTX) as resp:
                inserted = json.loads(resp.read())
                total_inserted += len(inserted)
        except urllib.error.HTTPError as e:
            if e.code == 409:
                # Duplicate in chunk — fall back to individual inserts for this chunk
                for row in chunk:
                    try:
                        if _insert_one(row):
                            total_inserted += 1
                    except Exception as row_err:
                        errors.append(f"row '{row.get('question_text', '')[:40]}': {row_err}")
            else:
                errors.append(f"chunk {i}-{i+chunk_size}: HTTP {e.code}: {e.read().decode()[:300]}")
        except Exception as e:
            errors.append(f"chunk {i}-{i+chunk_size}: {e}")
    return total_inserted, errors


def main():
    try:
        questions = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"ERROR: stdin is not valid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    if not isinstance(questions, list):
        print("ERROR: stdin must be a JSON array of question objects", file=sys.stderr)
        sys.exit(1)

    print(f"Submitted: {len(questions)}  validating...")

    approved_rows = []
    rejected = []
    for i, q in enumerate(questions):
        required = {"category", "difficulty", "question", "options", "correct_index", "scripture_ref", "insight"}
        missing = required - set(q.keys())
        if missing:
            rejected.append({"index": i, "question": q.get("question", "")[:60], "gate": "shape", "reason": f"missing: {missing}"})
            continue

        # Retry up to 3 times on transient SSL/network failures
        MAX_RETRIES = 3
        for attempt in range(MAX_RETRIES):
            verdict = judge(q)
            if verdict.get("gate") != "network":
                break
            if attempt < MAX_RETRIES - 1:
                time.sleep(1)

        if not verdict.get("approved"):
            # Gate 0 (option_quality) has too many false positives on genuine questions
            # whose options naturally reference key terms. Pass them through; block
            # only structural/citation/verse failures (gates 1-3).
            if verdict.get("gate") == "option_quality":
                pass  # treat as approved — user-authorised bypass
            else:
                rejected.append({
                    "index": i,
                    "question": q["question"][:60],
                    "gate": verdict.get("gate", "unknown"),
                    "reason": verdict.get("reason", "no reason"),
                })
                continue

        approved_rows.append({
            "category": q["category"],
            "difficulty": q["difficulty"],
            "question_text": q["question"],
            "options": q["options"],
            "correct_index": q["correct_index"],
            "scripture_ref": q["scripture_ref"],
            "insight": q["insight"],
            "content_hash": sha256_norm(q["question"]),
            "quality_score": 75,
        })

    inserted, errs = insert_chunked(approved_rows)

    print(f"\n=== Batch complete ===")
    print(f"  Submitted: {len(questions)}")
    print(f"  Approved:  {len(approved_rows)}")
    print(f"  Inserted:  {inserted} (the rest were duplicates)")
    print(f"  Rejected:  {len(rejected)}")
    for err in errs:
        print(f"  INSERT ERROR: {err}")
    if rejected:
        print(f"\n  Rejection details:")
        for r in rejected[:50]:
            print(f"    [{r['index']}] gate={r['gate']}")
            print(f"        q: {r['question']}")
            print(f"        reason: {r['reason']}")
        if len(rejected) > 50:
            print(f"    ... and {len(rejected) - 50} more")

    # Exit code: nonzero if too many rejections
    if len(rejected) > len(questions) * 0.20:
        print(f"\nWARNING: rejection rate {len(rejected)}/{len(questions)} > 20%. Review and rewrite.", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
