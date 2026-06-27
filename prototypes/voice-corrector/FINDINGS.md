# Context-aware voice corrector — grounded investigation

Status: investigation only. No prototype built yet. Dataset + technique grounded against Skip's real transcripts and the literature, per dig's reset (label real data, ground the technique, separate grounded-necessity from my decisions).

## 1. The labeled dataset (real, from Skip's transcripts)

`dataset.jsonl` — 23 instances mined from Skip's own fleet chat (6/16–6/26) via `search_logs`/`get_thread`, each with verbatim quote + timestamp + provenance. This is both the **eval harness** (accuracy is measured on these) and the **few-shot/conditioning seed**.

### What his real usage actually looks like (the headline finding)

The corpus does **not** look like the {5, fly, phi} story we'd been telling. Counts:

| Collision | Class | Count | Resolution |
|---|---|---|---|
| **demon → daemon** | context-free garble | **8** | always `daemon` |
| **phi → server** | context-dependent | **6** | `phi` (the Fly host) |
| **deep gram → Deepgram** | context-free garble | 3 | always `Deepgram` |
| **TL draw → tldraw**, **web kit → WebKit** | context-free garble | 2 | always the product |
| **phi → φ / proof-route** | context-dependent | 2 | math, weak (see below) |
| **fly → "flight"** | candidate | 1 (low conf) | unattested-ish |
| **5** as a collision | — | **0** | not found |

Three things fall out, and they matter:

1. **The dominant real error is context-FREE garbles, not context-dependent disambiguation.** "demon"→"daemon" alone is the single most frequent collision (8×), and together with deep gram / TL draw / web kit, the plain one-way vocabulary garbles outnumber every context-dependent case. These need **no topic model** — a personal-vocabulary normalizer fixes them regardless of context.

2. **The canonical motivating pair (phi=φ vs phi=server) is asymmetric in reality.** phi=server is strongly attested (6×, once he literally says "phi server"). phi=φ is **thin**: in math threads Skip's spoken "phi" refers to a *named proof route* (the agent's `varphi_i`/projection-anticoncentration route), not a dictated φ in prose — and when an agent means the symbol, the agent writes `φ`/`\varphi`, not Skip. So the "same token, two domains" case is real, but it's mostly phi→server with a long thin tail on the math side.

3. **"fly" and "5" as collisions are essentially unattested.** They are Skip's stated intuition (6/26 9:05: "5/fly/phi sound alike"), not observed data. One weak "flight"→"fly" candidate. So the {5,fly,phi} framing is a hypothesis to *test against this data*, not an established fact — exactly the spec-realness check.

**Design implication (grounded by the data):** the genuinely context-dependent disambiguation the topic model is for applies to a *small* set of tokens led by "phi". The bulk of measured pain is context-free vocab normalization. A real corrector should do **both**, and the eval should report accuracy **split by class**, so we don't credit the topic model for wins a lookup table already gets.

## 2. The technique, grounded (cites)

Skip named it: "this is classic NLP shit… topic model… topic transitions… like a fucking HMM… I'm sure there's more modern alternatives" (6/26 9:12–9:13). That's correct and it's a solved area: **topic segmentation / topic tracking**.

- **Classic / HMM (Skip's reference):** HMMs model a sequence with a latent topic state + transition matrix; used directly for conversation topic segmentation (Boufaden et al. 2001 on telephone transcripts; the *aspect-HMM* embeds an aspect/topic emission model). TopicTiling feeds LDA topic assignments into TextTiling. Latent state + sticky transitions = the persistence property we want.
- **Classic boundary detection:** TextTiling (Hearst 1997) — cosine similarity between adjacent text blocks; dips = boundaries.
- **Modern / embedding-based (the better fit):** Solbiati et al. 2021, *Unsupervised Topic Segmentation of Meetings with BERT Embeddings* (BertSeg) — SBERT sentence embeddings + a modified TextTiling. Recent work uses **kernel change-point detection on sentence embeddings**. These generalize semantically — a math turn that never says "theorem" still embeds near math content — which is exactly the regex-trap escape Skip demanded.

**The key distinction for us:** that literature mostly finds *boundaries* (segmentation). We need to *label the current domain* (math vs app/infra) — i.e. **online topic tracking/classification**, not boundary-finding. The grounded tool for labeling is **nearest-centroid classification on embeddings** (compute a centroid per domain from examples; classify the rolling-window embedding by cosine to nearest centroid — a standard few-shot text-classification method). Sentence embeddings run locally and cheaply in-process via **transformers.js** (`Xenova/all-MiniLM-L6-v2`, 384-dim, ONNX) — no API, no network, real-time.

**So the grounded synthesis** = an HMM whose **latent states are the domains**, **emissions are embedding-similarity to per-domain centroids**, and **transitions are sticky** (high self-transition so one ambiguous turn doesn't flip the topic). Online forward-filtering gives `P(domain | conversation so far)`. This is literally "the modern form of the HMM Skip named": HMM latent-state-+-transitions structure, embedding emissions for generalization, nearest-centroid for labeling.

## 3. Online learning from his corrections (Skip's "online RL")

Skip: "unless we're gonna take like an online kind of RL type approach to learning this" (6/26 9:16). Weighed honestly against the lit:

- **Corrections-as-labels is established.** *The Gift of Feedback* (arXiv 2310.00141): user edits to ASR output are corrected transcripts to learn from, especially for fresh/long-tail terms. *ASR slot correction through memorization* (2109.05092) and *Adapting an Unadaptable ASR System* (2306.01208) — memorize/retrieve past corrections.
- **Full RL is not warranted, and contextual bandits probably aren't either.** RL/bandits exist for **partial feedback** (a scalar reward for the one action you took, needing exploration). Skip's correction gives the **exact intended text** — full-information supervision, not a reward. With full labels, the right tool is **lightweight online-supervised / memory-based learning**: append each correction as a labeled example + update the personal lexicon/centroids; no exploration machinery. Contextual bandits are explicitly the supervised↔RL hybrid for *partial* feedback — we don't have that problem.
- **Catastrophic-forgetting caveat from the lit applies to weight fine-tuning, not to us.** Because we accumulate labeled examples + lexicon entries (not gradient-update an ASR model), we sidestep the forgetting/long-tail failure that naive on-device training hits.
- **Real corpus caveat (important):** Skip's in-chat corrections are **semantic restatements** ("no sorry what I was saying…"), not clean (wrong→right) token pairs. The clean labels (demon→daemon) come from observing the *garble in sent messages*, not from him correcting them in chat. So the "free label stream" he imagines must be captured at the **input-widget edit level** (what he deletes/retypes before sending), not mined from sent chat. That's an implementation cost to flag, not a free lunch.

**Bottom line:** online learning *composes* with the batch dataset (bootstrap from the labeled set; grow it from live edits), but it's **online-supervised/memory-based, not RL**. Build the batch eval first; add the edit-capture feedback loop second.

## 4. Grounded-necessity vs my decisions (kept separate, per dig)

**Forced by the data / lit (grounded):**
- Two error classes exist and context-free garbles dominate the real data — measured, not invented.
- Topic segmentation/tracking is the right frame for the ambiguous class; HMM (Skip) ↔ embedding-tracking (modern) are the real options.
- Corrections are full-information → online-supervised, not RL.
- Text-only post-correction (no audio) avoids hallucination drift (prior research, already in the recall-list).

**My decisions (not spec — open to change):**
- The domain set to start with: `{math, app/infra}` (could be finer).
- Nearest-centroid labeling + sticky-transition forward filter as the concrete topic-tracker, vs a heavier trained HMM/neural segmenter. (I'd start minimal.)
- `transformers.js` MiniLM local embeddings vs an embeddings API. (Local, for a real-time no-network corrector.)
- The apply-vs-flag confidence threshold (conservative; flag the thin math-phi and the unattested 5/fly rather than guess).
- **Sequencing recommendation:** prototype the context-free vocabulary normalizer first (it captures the majority of attested pain and needs no topic model), then layer the topic-tracked disambiguator for "phi", and measure each class's accuracy separately on `dataset.jsonl`. The dataset is the proof either way.

## Sources
- Hearst 1997 (TextTiling); Boufaden et al. 2001 (HMM conversation segmentation); TopicTiling (LDA+TextTiling).
- Solbiati et al. 2021, *Unsupervised Topic Segmentation of Meetings with BERT Embeddings* — https://arxiv.org/pdf/2106.12978
- *Recent Trends in Linear Text Segmentation: A Survey* — https://arxiv.org/html/2411.16613v1
- transformers.js `Xenova/all-MiniLM-L6-v2` (local ONNX sentence embeddings).
- *The Gift of Feedback* (learning from user ASR corrections) — https://arxiv.org/html/2310.00141
- *Remember the context! ASR slot error correction through memorization* — https://arxiv.org/pdf/2109.05092
- *Adapting an Unadaptable ASR System* — https://arxiv.org/pdf/2306.01208
- COLING 2025 conversational context-aware LLM correction — https://arxiv.org/abs/2501.06129 (already in recall-list)
