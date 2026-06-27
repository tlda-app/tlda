# Impl spec — context-free vocabulary normalizer (Phase 1)

This spec is grounded in real labeled data, not invented. Read `prototypes/voice-corrector/dataset.jsonl` and `prototypes/voice-corrector/FINDINGS.md` first — the dataset is your eval set and the source of every rule.

**Scope: Phase 1 ONLY — the context-free vocabulary normalizer.** Do NOT build a topic model, an LLM call, or the "phi" context disambiguator — that's Phase 2 and it's on hold pending Skip. Anything context-dependent is out of scope.

## What it is

A pure, deterministic text→text function that fixes Skip's **context-independent** transcription garbles using a personal vocabulary map. These are one-way homophone/word-split errors that are correct to fix regardless of topic (e.g. "demon"→"daemon" 8× in the data). No ML, no LLM — a deterministic normalizer is the *correct* tool here, and the lowest-risk biggest attested win.

## Files to create (all under `prototypes/voice-corrector/`)

### `vocab.json` — the personal map (ATTESTED rules only)
Seed it **only** from the `context-free-garble` entries in `dataset.jsonl`. Do not invent rules for unattested terms.
```json
{
  "rules": [
    { "surface": "demon",     "to": "daemon",   "match": "word"   },
    { "surface": "deep gram", "to": "Deepgram", "match": "phrase" },
    { "surface": "tl draw",   "to": "tldraw",   "match": "phrase" },
    { "surface": "web kit",   "to": "WebKit",   "match": "phrase" }
  ]
}
```
- `match: "word"` = whole-word, case-insensitive boundary match; preserve nothing fancy, just replace the word.
- `match: "phrase"` = match the multi-word surface case-insensitively (allow 1+ spaces between words), replace with `to`.
- Add a top-of-file comment noting "demon"→"daemon" is a deliberate personal mapping with a known false-positive risk (the English word "demon"); acceptable because this is Skip's personal normalizer and "daemon" is the only attested sense.

### `normalize.mjs` — the module
```
export function normalize(text, vocab) -> { corrected, edits: [{ from, to, rule }] }
```
- Apply each rule; `edits` lists every replacement made. If nothing matched, `corrected === text` and `edits` is empty.
- **Safety: only ever replace the exact surfaces in `vocab`. Never free-rewrite anything else.** Whole-word / phrase boundaries only (don't corrupt substrings — "pandemonium" must not become "pandaemonium"; "tl drawing" handling: only match the standalone phrase, be conservative).
- Deterministic and synchronous. No network, no LLM, no deps beyond Node stdlib.

### `eval.mjs` — the eval harness (per-class accuracy is the deliverable)
- Load `dataset.jsonl`. For each instance, run `normalize(msg_excerpt, vocab)`.
- Report accuracy **split by class** (this is required — nothing gets credit it didn't earn):
  - **context-free-garble**: PASS iff the normalizer produced the `correct` form (it fixed the garble). Target: ~100%.
  - **context-dependent** (phi→server, phi→math): PASS iff the normalizer **left the text unchanged** — these need the held Phase-2 topic model, so the *correct* Phase-1 behavior is to NOT touch them (no false rewrite). Report this as an "abstention" rate.
  - **correction-event / candidate-garble**: report separately, not scored (note them).
- Print a clear per-class table: class, n, passed, accuracy. Also print any FALSE rewrites (normalizer changed a context-dependent or unrelated token) — those are failures and must be zero.
- Exit non-zero if any false rewrite occurs or context-free accuracy < 100%.

### `README.md`
One short paragraph: what Phase 1 is, how to run (`node eval.mjs`), and a one-line pointer that Phase 2 (topic-tracked "phi" disambiguator) is intentionally deferred pending Skip's call, and that the real online-learning label stream is widget-level edits (not sent chat) per FINDINGS.

## Done =
- `node eval.mjs` runs clean: context-free-garble accuracy 100%, zero false rewrites on context-dependent cases, per-class table printed.
- No topic model / LLM / phi-disambiguation code anywhere.
- Committed (no push to any public remote).

Report back to your manager (voice-corrector-mgr) with the per-class accuracy table and the eval output. A critic will gate it before it's called done.
