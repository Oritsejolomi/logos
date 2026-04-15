import { handleOptions, jsonResponse, errorResponse } from '../_shared/supabase-admin.ts';
import { validateOptionQuality, type GeneratedQuestion } from '../_shared/gemini.ts';
import { verseLookup } from '../_shared/bible-lookup.ts';
import { validateScriptureRef } from '../_shared/bible-refs.ts';

// Standalone deterministic validator. Runs Gates 0, 1, and 3 against a
// fully-formed question. NO LLM call — Sonnet handles the semantic judge in
// chat before submitting.
//
// Used by the bank bulk-load script to validate Sonnet-written questions
// before inserting them into the production questions table.

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  if (req.method !== 'POST') return errorResponse(405, 'Method not allowed');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return errorResponse(400, 'Invalid JSON body'); }

  const { question, options, correct_index, scripture_ref, insight } = body as {
    question?: string;
    options?: unknown;
    correct_index?: number;
    scripture_ref?: string;
    insight?: string;
  };

  if (typeof question !== 'string' || !question.trim()) {
    return jsonResponse({ approved: false, gate: 'shape', reason: 'question must be a non-empty string' });
  }
  if (!Array.isArray(options) || options.length !== 4 || !options.every((o) => typeof o === 'string' && o.trim())) {
    return jsonResponse({ approved: false, gate: 'shape', reason: 'options must be an array of exactly 4 non-empty strings' });
  }
  if (typeof correct_index !== 'number' || correct_index < 0 || correct_index > 3) {
    return jsonResponse({ approved: false, gate: 'shape', reason: 'correct_index must be 0-3' });
  }
  if (typeof scripture_ref !== 'string' || !scripture_ref.trim()) {
    return jsonResponse({ approved: false, gate: 'shape', reason: 'scripture_ref must be a non-empty string' });
  }

  const q: GeneratedQuestion = {
    question,
    options: options as string[],
    correct_index,
    scripture_ref,
    insight: insight ?? '',
  };

  // Gate 0: option quality (parenthetical, stem-word echo)
  const quality = validateOptionQuality(q);
  if (!quality.ok) return jsonResponse({ approved: false, gate: 'option_quality', reason: quality.reason });

  // Gate 1: citation parses as a real book/chapter/verse
  const refCheck = validateScriptureRef(scripture_ref);
  if (!refCheck.ok) return jsonResponse({ approved: false, gate: 'citation_parse', reason: refCheck.reason });

  // Gate 3: verse text exists in bible_verses corpus (the strongest deterministic
  // anti-hallucination gate we have — if the cited verse isn't in the corpus,
  // either the citation is wrong or the verse is real but we don't have its text).
  const verseText = await verseLookup(scripture_ref).catch(() => null);
  if (!verseText) {
    return jsonResponse({
      approved: false,
      gate: 'verse_lookup',
      reason: `verse text not found in bible_verses table for ${scripture_ref}`,
    });
  }

  // Approved. Sonnet's in-chat self-critique handled Gate 2 (semantic judge).
  return jsonResponse({ approved: true });
});
