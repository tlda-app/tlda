// Deterministic test for ribbon segment coalescing (segment-bloat fix).
//
// Mirrors the two pure helpers in src/ribbonInteraction.ts: mergeSegment (trim
// overlaps + insert) and normalizeSegments (coalesce contiguous same-status
// runs). setSegments() runs normalizeSegments on every write, so this models a
// realistic mark+erase session and asserts:
//   (a) the segment count stays bounded over many cycles (no runaway growth),
//   (b) adjacent same-status segments actually merge,
//   (c) an erased band leaves a real gap (erase clears, doesn't net-add).
//
// The helpers are replicated here (not imported) because ribbonInteraction.ts
// pulls in the tldraw/React render chain; the logic below is kept in lockstep
// with the source.

const COALESCE_GAP_PX = 1.5

function mergeSegment(existing, newSeg) {
  const result = []
  for (const seg of existing) {
    if (seg.y2 <= newSeg.y1 || seg.y1 >= newSeg.y2) {
      result.push(seg)
      continue
    }
    if (seg.y1 < newSeg.y1) {
      result.push({ ...seg, y2: newSeg.y1, endLine: newSeg.startLine, endFile: newSeg.startFile })
    }
    if (seg.y2 > newSeg.y2) {
      result.push({ ...seg, y1: newSeg.y2, startLine: newSeg.endLine, startFile: newSeg.endFile })
    }
  }
  if (newSeg.status !== 'unchecked') result.push(newSeg)
  result.sort((a, b) => a.y1 - b.y1)
  return result
}

function normalizeSegments(segments) {
  const colored = segments
    .filter(s => s.status !== 'unchecked' && s.y2 - s.y1 > 0)
    .sort((a, b) => a.y1 - b.y1 || a.y2 - b.y2)
  const out = []
  for (const seg of colored) {
    const last = out[out.length - 1]
    if (last && last.status === seg.status && seg.y1 <= last.y2 + COALESCE_GAP_PX) {
      if (seg.y2 > last.y2) {
        last.y2 = seg.y2
        last.endLine = seg.endLine
        last.endFile = seg.endFile
      }
    } else {
      out.push({ ...seg })
    }
  }
  return out
}

let failures = 0
function assert(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); failures++ }
  else console.log('  ✓ ' + msg)
}

// Deterministic PRNG so the run is reproducible.
let _s = 123456789
function rnd() { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff }

const seg = (y1, y2, status) => ({ startLine: y1, endLine: y2, startFile: '', endFile: '', status, y1, y2 })

// ---------------------------------------------------------------------------
console.log('(b) adjacent same-status segments merge:')
{
  let segs = []
  segs = normalizeSegments(mergeSegment(segs, seg(0, 50, 'uncertain')))
  segs = normalizeSegments(mergeSegment(segs, seg(50, 100, 'uncertain')))
  assert(segs.length === 1, `two touching uncertain bands → 1 segment (got ${segs.length})`)
  assert(segs[0].y1 === 0 && segs[0].y2 === 100, `merged span is [0,100] (got [${segs[0].y1},${segs[0].y2}])`)
}

console.log('different-status adjacent stay separate:')
{
  let segs = []
  segs = normalizeSegments(mergeSegment(segs, seg(0, 50, 'uncertain')))
  segs = normalizeSegments(mergeSegment(segs, seg(50, 100, 'approved')))
  assert(segs.length === 2, `uncertain then approved → 2 segments (got ${segs.length})`)
}

// ---------------------------------------------------------------------------
console.log('(c) erase leaves a real gap (clears, not net-add):')
{
  let segs = []
  segs = normalizeSegments(mergeSegment(segs, seg(0, 100, 'approved')))
  assert(segs.length === 1, `mark [0,100] → 1 segment`)
  // erase a 12px band in the middle (unchecked → removal)
  segs = normalizeSegments(mergeSegment(segs, seg(40, 52, 'unchecked')))
  assert(segs.length === 2, `erase middle → 2 pieces with a gap (got ${segs.length})`)
  const gapTop = segs[0].y2, gapBot = segs[1].y1
  assert(gapBot - gapTop > COALESCE_GAP_PX, `gap (${(gapBot - gapTop).toFixed(1)}px) survives coalescing`)
  // erasing the same band again must NOT create more fragments
  const before = segs.length
  segs = normalizeSegments(mergeSegment(segs, seg(40, 52, 'unchecked')))
  assert(segs.length === before, `re-erasing same band is idempotent (${before} → ${segs.length})`)
}

// ---------------------------------------------------------------------------
console.log('(a) count stays bounded over a long mark+erase session:')
{
  const statuses = ['uncertain', 'approved', 'presentation']
  const DOC_H = 4000

  // WITHOUT coalescing (the regression): mergeSegment only, no normalize.
  let raw = []
  // WITH coalescing (the fix): normalize on every write.
  let fixed = []

  let rawPeak = 0, fixedPeak = 0
  for (let i = 0; i < 2000; i++) {
    const y = rnd() * (DOC_H - 60)
    const h = 8 + rnd() * 50
    const status = statuses[(rnd() * statuses.length) | 0]
    const mark = seg(y, y + h, status)
    // ~40% of actions are erases (a small scrub band)
    const isErase = rnd() < 0.4
    const action = isErase ? seg(y, y + 12, 'unchecked') : mark

    raw = mergeSegment(raw, action)
    fixed = normalizeSegments(mergeSegment(fixed, action))

    rawPeak = Math.max(rawPeak, raw.length)
    fixedPeak = Math.max(fixedPeak, fixed.length)
  }

  console.log(`    raw (no coalesce) peak: ${rawPeak} segments`)
  console.log(`    fixed (coalesce)  peak: ${fixedPeak} segments`)
  assert(fixedPeak < rawPeak, `coalesced peak (${fixedPeak}) < raw peak (${rawPeak})`)
  // A 4000px doc with 3 statuses can't hold more colored runs than ~DOC_H/minGap;
  // in practice it settles to a small handful. Assert a hard, generous bound.
  assert(fixedPeak <= 200, `coalesced count stays bounded (peak ${fixedPeak} ≤ 200)`)
  // And no monotonic runaway: the fixed set is the same whether we feed 2000 or
  // re-normalize — idempotence check.
  assert(normalizeSegments(fixed).length === fixed.length, `normalize is idempotent on the final set`)
}

// ---------------------------------------------------------------------------
// Faithful reproduction of the 43k bloat: many tiny ADJACENT same-status bands
// (what accumulates when marking/erasing repeatedly with no coalescing). This
// is the exact pathology ops measured.
console.log('(a2) adjacent-fragment bloat — the 43k mechanism:')
{
  const N = 5000
  let raw = []
  let fixed = []
  for (let i = 0; i < N; i++) {
    // 4px-tall band butting against the previous one, same status.
    const band = seg(i * 4, i * 4 + 4, 'uncertain')
    raw = mergeSegment(raw, band)                          // no coalesce
    fixed = normalizeSegments(mergeSegment(fixed, band))   // coalesce
  }
  console.log(`    raw (no coalesce): ${raw.length} segments`)
  console.log(`    fixed (coalesce):  ${fixed.length} segments`)
  assert(raw.length === N, `without coalescing, ${N} adjacent bands → ${N} segments (the bloat)`)
  assert(fixed.length === 1, `with coalescing, ${N} adjacent same-status bands → 1 segment (got ${fixed.length})`)
  assert(fixed[0].y1 === 0 && fixed[0].y2 === N * 4, `single merged span covers the whole run`)
}

console.log('')
if (failures) { console.error(`FAILED: ${failures} assertion(s)`); process.exit(1) }
else console.log('ALL PASS')
