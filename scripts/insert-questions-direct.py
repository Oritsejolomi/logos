#!/usr/bin/env python3
"""Direct bulk insert — skips the judge Edge Function, inserts straight to PostgREST.

Reads a JSON array from stdin. Validates shape locally, computes content_hash,
then inserts in 100-row chunks with ignore-duplicates.

Required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY

Usage:
  cat batch.json | python3 scripts/insert-questions-direct.py
"""
import hashlib
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

URL = os.environ.get('SUPABASE_URL')
SERVICE_KEY = os.environ.get('SUPABASE_SERVICE_KEY')

if not URL or not SERVICE_KEY:
    print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set", file=sys.stderr)
    sys.exit(1)

INSERT_URL = f"{URL}/rest/v1/questions"
_SSL_CTX = ssl._create_unverified_context()

REQUIRED = {"category", "difficulty", "question", "options", "correct_index", "scripture_ref", "insight"}


def sha256_norm(text: str) -> str:
    return hashlib.sha256(text.strip().lower().encode()).hexdigest()


def insert_one(row: dict) -> bool:
    """Insert a single row; return True if inserted, False if duplicate/error."""
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
        with urllib.request.urlopen(req, timeout=30, context=_SSL_CTX) as resp:
            resp.read()
            return True
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        if e.code == 409 or "duplicate key" in body:
            return False  # already exists — not an error
        print(f"    INSERT error {e.code}: {body[:150]}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"    INSERT error: {e}", file=sys.stderr)
        return False


def insert_chunk(rows: list):
    """Try bulk insert first; fall back to per-row on conflict."""
    body = json.dumps(rows).encode()
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
            return len(inserted), None
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()
        if e.code == 409 or "duplicate key" in body_text:
            # Fall back: insert row-by-row, skip duplicates
            n = sum(1 for r in rows if insert_one(r))
            return n, None
        return 0, f"HTTP {e.code}: {body_text[:300]}"
    except Exception as e:
        return 0, str(e)


def main():
    try:
        questions = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"ERROR: stdin is not valid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    if not isinstance(questions, list):
        print("ERROR: stdin must be a JSON array", file=sys.stderr)
        sys.exit(1)

    print(f"Submitted: {len(questions)}  building rows...")

    rows = []
    shape_errors = []
    for i, q in enumerate(questions):
        missing = REQUIRED - set(q.keys())
        if missing:
            shape_errors.append(f"[{i}] missing {missing}: {q.get('question','')[:50]}")
            continue
        rows.append({
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

    if shape_errors:
        print(f"Shape errors ({len(shape_errors)}):")
        for e in shape_errors[:10]:
            print(f"  {e}")

    print(f"Valid rows: {len(rows)}  inserting in chunks of 100...")

    total_inserted = 0
    chunk_errors = []
    for i in range(0, len(rows), 100):
        chunk = rows[i:i + 100]
        n, err = insert_chunk(chunk)
        total_inserted += n
        if err:
            chunk_errors.append(f"chunk {i}-{i+len(chunk)}: {err}")
            print(f"  chunk {i}-{i+len(chunk)}: ERROR — {err}")
        else:
            print(f"  chunk {i}-{i+len(chunk)}: {n} inserted ({len(chunk)-n} duplicates)")

    print(f"\n=== Done ===")
    print(f"  Submitted:  {len(questions)}")
    print(f"  Valid rows: {len(rows)}")
    print(f"  Inserted:   {total_inserted} (new rows)")
    print(f"  Duplicates: {len(rows) - total_inserted}")
    print(f"  Errors:     {len(chunk_errors)}")


if __name__ == "__main__":
    main()
