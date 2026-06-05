// Outline token-model layer: the "tokens, not words" enforcement.
//
// `outline.mjs` owns STRUCTURE (a region -> ordered leaf spans with depth) and
// the clean note render. This module adds the ROUND-TRIP layer on top of those
// same spans so agents can only MOVE (reorder/reparent a token) or INSERT (add a
// [NEW] candidate) — never rewrite a token. Three pieces:
//
//   buildModel(text, structuralLeaves) -> { head, leaves:[{id,level,kind,text,body,joinerAfter}], ... }
//   render(model, entries)             -> reconstructed .tex from a reordered token list (+ inserts)
//   check(model, entries)              -> { violations, moves, inserts, deletes }  (rewrite => violation)
//
// Invariant: head + Σ(text_i + joinerAfter_i) in ORIGINAL order === region
// byte-for-byte. `level`/`body` are display-only; the partition is what round-trips.

const viewText = (s) => s.replace(/\s+/g, ' ').trim()

// ---------- build the frozen-token model from structural offset spans ----------
// `leaves` is the output of outline.mjs `structuralLeaves(text)`:
//   [{ start, end, level, kind, body? }]  — ordered, NON-OVERLAPPING.
// Everything between one leaf's end and the next leaf's start is a verbatim
// joiner; everything before the first leaf is the head. That partition is what
// guarantees exact reconstruction.
export function buildModel(text, leaves) {
  const sorted = [...leaves].sort((a, b) => a.start - b.start)
  const head = sorted.length ? text.slice(0, sorted[0].start) : text
  const out = sorted.map((lf, i) => {
    const next = sorted[i + 1]
    const joinerEnd = next ? next.start : text.length
    const verbatim = text.slice(lf.start, lf.end)
    return {
      id: 'l' + (i + 1),
      level: lf.level ?? (lf.kind === 'label' ? 0 : 1),
      kind: lf.kind,
      text: verbatim,
      body: lf.body ?? viewText(verbatim),
      joinerAfter: text.slice(lf.end, joinerEnd),
    }
  })
  return { head, leaves: out }
}

// Sanity check that a model partitions the region exactly. Throw early in dev so
// a structuralLeaves regression (overlapping spans, gaps eaten) can't silently
// corrupt round-trip.
export function assertRoundTrip(model, region) {
  let rebuilt = model.head
  for (const lf of model.leaves) rebuilt += lf.text + lf.joinerAfter
  if (rebuilt !== region) {
    throw new Error('outline model does not round-trip — structuralLeaves spans are not an exact partition')
  }
}

// ---------- the id-tagged outline the agent edits ----------
// `- [l3]   By Lemma 4.2 …`  at indent = level. This is what outline_open returns
// and what outline_apply parses back.
export function emitModelMarkdown(model) {
  const lines = []
  for (const lf of model.leaves) {
    const indent = '  '.repeat(lf.level)
    const tag = lf.kind === 'label' ? '¶ ' : lf.kind === 'display' ? '⟦display⟧ ' : ''
    lines.push(`${indent}- [${lf.id}] ${tag}${lf.body}`)
  }
  return lines.join('\n') + '\n'
}

// ---------- parse the edited id-tagged markdown back into ordered entries ----------
// Each dash item is either an existing token `[lN] shown text` (a MOVE if its
// position changed) or an insert (`[NEW] text`, or a bare dash line) (an INSERT).
export function parseEditedOutline(md) {
  const entries = []
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!/^\s*-\s/.test(line)) continue
    const body = line.replace(/^\s*-\s/, '')
    const idm = body.match(/^\[([A-Za-z0-9]+)\]\s?(.*)$/s)
    if (idm && idm[1].toUpperCase() !== 'NEW') {
      entries.push({ id: idm[1], shownText: viewText(idm[2].replace(/^(¶|⟦display⟧)\s*/, '')) })
    } else {
      const newText = idm ? idm[2] : body
      entries.push({ newText: newText.trim() })
    }
  }
  return entries
}

// ---------- render: reconstruct the .tex from a (possibly reordered) entry list ----------
export function render(model, entries) {
  const byId = Object.fromEntries(model.leaves.map((l) => [l.id, l]))
  let out = model.head
  for (const e of entries) {
    if (e.id && byId[e.id]) {
      const lf = byId[e.id]
      out += lf.text + lf.joinerAfter
    } else if (e.newText !== undefined) {
      out += e.newText + ' '
    }
  }
  return out
}

// ---------- check: classify the edit, reject any rewritten token ----------
// The single gate behind "tokens, not words": if a token's shown text differs
// from its verbatim source, that's a TEXT REWRITTEN violation and the apply is
// rejected. Moves (order changes), inserts ([NEW]), and deletes are reported but
// allowed — they're structural, not rewrites.
export function check(model, entries) {
  const byId = Object.fromEntries(model.leaves.map((l) => [l.id, l]))
  const origOrder = model.leaves.map((l) => l.id)
  const editedIds = entries.filter((e) => e.id).map((e) => e.id)
  const violations = [], moves = [], inserts = [], deletes = []

  for (const e of entries) {
    if (e.id) {
      const lf = byId[e.id]
      if (!lf) { violations.push(`unknown token id [${e.id}]`); continue }
      // The agent edits against `body` (the rendered/displayed text shown in the
      // outline), so validate against `body` — NOT the verbatim `text`, which
      // differs whenever a token has \ref/\textbf/$$/\label etc. `render` still
      // reconstructs from the verbatim `text` (by id), so prose is preserved no
      // matter what; `check` only guards that the agent didn't alter the words.
      if (e.shownText !== viewText(lf.body)) {
        violations.push(
          `token [${e.id}] TEXT REWRITTEN — agents may only move tokens, not edit them` +
          `\n      was:  "${viewText(lf.body)}"` +
          `\n      now:  "${e.shownText}"`
        )
      }
    } else if (e.newText !== undefined) {
      inserts.push(e.newText)
    }
  }
  for (const id of origOrder) if (!editedIds.includes(id)) deletes.push(id)

  const keptInOrder = origOrder.filter((id) => editedIds.includes(id))
  if (JSON.stringify(editedIds) !== JSON.stringify(keptInOrder)) moves.push('token order changed')

  return { violations, moves, inserts, deletes }
}
