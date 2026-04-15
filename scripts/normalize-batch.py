#!/usr/bin/env python3
"""Normalize question JSON field names to match insert-questions.py schema.

Handles both field name variants:
  correct_answer (string) → correct_index (int, looked up in options)
  scripture_reference      → scripture_ref
  explanation              → insight

Usage:
  python3 scripts/normalize-batch.py input.json output.json
"""
import json, sys

if len(sys.argv) != 3:
    print("Usage: normalize-batch.py input.json output.json", file=sys.stderr)
    sys.exit(1)

with open(sys.argv[1]) as f:
    questions = json.load(f)

out, errors = [], []
for i, q in enumerate(questions):
    if "correct_index" in q:
        idx = q["correct_index"]
    elif "correct_answer" in q:
        try:
            idx = q["options"].index(q["correct_answer"])
        except ValueError:
            errors.append(f"[{i}] correct_answer not in options: {q.get('question','')[:60]}")
            continue
    else:
        errors.append(f"[{i}] no correct_index or correct_answer")
        continue

    out.append({
        "category": q["category"],
        "difficulty": q["difficulty"],
        "question": q["question"],
        "options": q["options"],
        "correct_index": idx,
        "scripture_ref": q.get("scripture_ref", q.get("scripture_reference", "")),
        "insight": q.get("insight", q.get("explanation", "")),
    })

with open(sys.argv[2], "w") as f:
    json.dump(out, f, indent=2)

print(f"Normalized {len(out)}/{len(questions)} questions → {sys.argv[2]}")
if errors:
    print(f"Errors ({len(errors)}):")
    for e in errors[:10]:
        print(f"  {e}")
