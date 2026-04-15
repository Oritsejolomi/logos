#!/usr/bin/env bash
# Wrapper: normalize + insert a category batch through judge-question (all 4 gates).
# Usage: bash scripts/run-insert.sh <category-slug>
# Example: bash scripts/run-insert.sh new-testament
set -euo pipefail

SLUG="${1:?Usage: run-insert.sh <category-slug>}"
RAW="/tmp/batches/${SLUG}.json"
READY="/tmp/batches/${SLUG}-ready.json"

SUPABASE_URL="https://rnezgrieymrqdlmwknvj.supabase.co"
SUPABASE_ANON_KEY="REDACTED_ANON_KEY"
SUPABASE_SERVICE_KEY="REDACTED_SERVICE_KEY"

echo "=== Concatenating chunks for: $SLUG ==="
python3 -c "
import json, glob, sys
files = sorted(glob.glob('/tmp/batches/${SLUG}-chunk-*.json'))
if not files:
    print('No chunk files found for ${SLUG}', file=sys.stderr)
    sys.exit(1)
q = []
for f in files:
    data = json.load(open(f))
    print(f'  {f}: {len(data)} questions')
    q.extend(data)
json.dump(q, open('${RAW}', 'w'), indent=2)
print(f'Total: {len(q)} questions → ${RAW}')
"

echo ""
echo "=== Normalizing fields ==="
python3 scripts/normalize-batch.py "$RAW" "$READY"

echo ""
echo "=== Inserting through judge-question (all 4 gates) ==="
export SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_KEY
python3 scripts/insert-questions.py < "$READY"

echo ""
echo "=== Spot-check count in DB ==="
curl -s "${SUPABASE_URL}/rest/v1/questions?select=id&category=eq.${SLUG//'-'/' '}" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Prefer: count=exact" -I 2>/dev/null | grep -i "content-range" || true
