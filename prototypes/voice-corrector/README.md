# Voice Corrector Phase 1

Phase 1 is a deterministic, context-free vocabulary normalizer for Skip's attested transcription garbles. It applies only the personal `vocab.json` map seeded from `context-free-garble` rows in `dataset.jsonl`; it does not use an LLM, network calls, a topic model, or phi/context disambiguation.

Run the eval with:

```sh
node eval.mjs
```

Phase 2, the topic-tracked `"phi"` disambiguator, is intentionally deferred pending Skip's call. The real online-learning label stream should come from widget-level edits rather than sent chat, per `FINDINGS.md`.
