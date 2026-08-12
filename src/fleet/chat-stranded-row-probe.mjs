// chat-stranded-row-probe — transition-only telemetry for the one failure it
// exists to catch: the chat's virtualized item list keeping DOM rows React has
// stopped owning.
//
// WHAT WAS MEASURED, so the next reader does not re-derive it. In Skip's live
// session on 2026-08-12, one chat panel's item list held nine DOM children while
// React owned four. The five extras carried duplicated `data-index` values and
// 192px of height: `padding-top` 118971 plus the four owned rows came to 130926,
// and the box measured 131118. Virtuoso positions every row from that model, so
// each row below the strays sits 192px from where the scroller believes it is —
// which is what "I scroll a little and shit pops into existence in the middle of
// the screen" looks like from the inside. The sibling panel in the same tab
// measured exact.
//
// WHY THIS EXISTS AT ALL. Everything about those five nodes is after-the-fact.
// They had been stranded for over an hour by the time anyone looked, and no
// evidence available from outside names the commit that stranded them. Six
// hypotheses died on measurements — a duplicated message in the item array, a
// nested `createRoot` unmounting inside the deleting commit, the `firstItemIndex`
// arithmetic, the pill drop target's node, canvas scale, and a factor ladder over
// tall rows / live head eviction / a ResizeObserver writing scrollTop. None of
// them reproduced it. The frame of creation is the one thing left, and only the
// real panel produces it.
//
// WHY DUPLICATE KEYS ARE THE TRIGGER, AND NOT A FIBER WALK. The detector that
// found this originally walked React's fiber tree, and React keeps an `alternate`
// tree, so a sample can read the one that is not current and invent a stray. That
// error produced a clean-looking A/B result that was entirely artifact. The
// version that survives every objection needs no fiber at all: three DOM wrappers
// carried key `2629451` while that key appeared exactly once in the item array,
// across 4500 samples with zero array-side duplicates. A duplicate key among the
// list's own children is therefore both sound and immediate — it is true in the
// same batch that creates the stray, before any later eviction shifts indices.
//
// WHY log.metric. The default namespace threshold is `warn` and `shouldLog`
// returns before enqueue, so `log.debug` here would write nothing without a URL
// param the user is never going to set. See chat-freeze-probe.mjs, which learned
// this the expensive way.
//
// RECORD ONLY. This observer never adds, removes, moves, or restyles a node, and
// it must stay that way. Sweeping the strays would make the height arithmetic
// come out right while whatever creates them kept running, and the next stray
// would put it straight back.

import { log } from '../logger.ts'

const NS = 'chat-stranded-row'

// A wedged panel can churn its child list continuously. These bound what one
// panel can write for one page load; the failure is a step change, so the first
// few records carry the whole story and the rest would be repetition.
const MAX_RECORDS_PER_PANEL = 12
// How much history travels with a record. The interesting question is what the
// list was doing just BEFORE the stray appeared, and a stranding is preceded by
// a re-render, not by a long quiet period.
const BATCH_HISTORY = 10

function rowKey(node) {
  if (!(node instanceof Element)) return null
  if (node.hasAttribute('data-chat-item-key')) return node.getAttribute('data-chat-item-key')
  return node.querySelector?.('[data-chat-item-key]')?.getAttribute('data-chat-item-key') ?? null
}

function describe(node) {
  return {
    index: node instanceof Element ? node.getAttribute('data-index') : null,
    key: rowKey(node),
    knownSize: node instanceof Element ? node.getAttribute('data-known-size') : null,
  }
}

/** Keys carried by more than one of the list's current children. */
function duplicateChildKeys(list) {
  const counts = new Map()
  for (const child of list.children) {
    const key = rowKey(child)
    if (key == null) continue
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const dups = []
  for (const [key, n] of counts) if (n > 1) dups.push({ key, n })
  return dups
}

/**
 * Children sitting at a `data-index` the item array does not agree with.
 *
 * The duplicate-key test only sees a stray while the row it duplicates is ALSO
 * rendered, and a virtualizer will scroll away from that within a frame. The
 * five strays in the live session sat at indices 15 and 16 while the window had
 * moved past 167, so by the time anyone looked their twins were long gone —
 * they stayed visible as duplicates only because those same keys had aged back
 * to the head of the array. That is luck, not a detector, so this is the half
 * that does not depend on it.
 */
function misplacedChildren(list, keys) {
  const misplaced = []
  for (const child of list.children) {
    const key = rowKey(child)
    if (key == null) continue
    const index = Number(child.getAttribute('data-index'))
    if (!Number.isInteger(index)) continue
    if (keys[index] === key) continue
    misplaced.push({ key, index, arrayKeyAtIndex: keys[index] ?? null })
  }
  return misplaced
}

/**
 * Watch one chat panel's Virtuoso item list for rows React has stopped owning.
 *
 * @param {Element | null | undefined} list the `[data-testid="virtuoso-item-list"]` element
 * @param {{
 *   panelId: string,
 *   itemKeys: () => readonly (string | number)[],
 *   firstItemIndex: () => number,
 * }} panel reads the panel's CURRENT render state at record time — passed as
 *   functions so the observer is not rebuilt every time the item array changes.
 * @returns {() => void} disconnect
 */
export function watchChatStrandedRows(list, panel) {
  if (!list || typeof MutationObserver === 'undefined') return () => {}

  const history = []
  let recorded = 0
  // High-water mark, not a boolean: five strays arriving one at a time is five
  // separate events worth a record, while a steady five is one event already
  // reported. A panel that is merely still broken stays silent.
  let reportedStrays = 0
  // Keys that looked misplaced in the previous batch and are waiting to be
  // confirmed by this one.
  let pendingMisplaced = new Set()

  const observer = new MutationObserver((mutations) => {
    const added = []
    const removed = []
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) added.push(describe(node))
      for (const node of mutation.removedNodes) removed.push(describe(node))
    }
    if (added.length === 0 && removed.length === 0) return

    const batch = { t: Date.now(), added, removed }
    history.push(batch)
    if (history.length > BATCH_HISTORY) history.shift()

    const keys = panel.itemKeys().map(String)
    const duplicates = duplicateChildKeys(list)

    // An index mismatch is true for one batch whenever the array changes ahead
    // of the children being re-rendered, so a single sighting proves nothing.
    // Requiring it to survive the NEXT batch costs nothing here — the strays in
    // the live session persisted for over an hour — and it is what separates a
    // stranded row from a frame of ordinary re-render lag.
    const misplaced = misplacedChildren(list, keys)
    const misplacedKeys = new Set(misplaced.map(entry => entry.key))
    const confirmed = misplaced.filter(entry => pendingMisplaced.has(entry.key))
    pendingMisplaced = misplacedKeys

    const total = duplicates.reduce((sum, entry) => sum + entry.n - 1, 0) + confirmed.length
    if (total <= reportedStrays) {
      // Strays can also go away — a later render may collect them. Track the
      // mark downward so a recurrence is reported as a new event.
      reportedStrays = total
      return
    }
    reportedStrays = total
    if (recorded >= MAX_RECORDS_PER_PANEL) return
    recorded++

    const arrayCounts = new Map()
    for (const key of keys) arrayCounts.set(key, (arrayCounts.get(key) || 0) + 1)

    log.metric(NS, 'item list kept a row react stopped owning', {
      panelId: panel.panelId,
      // The claim, in the two numbers that make it: this key is on N children of
      // the list, and appears this many times in the array those children render
      // from. An array-side count of 1 against a DOM count above 1 is the whole
      // finding, and it needs no fiber tree to stand up.
      duplicates: duplicates.map(entry => ({
        key: entry.key,
        domCount: entry.n,
        arrayCount: arrayCounts.get(entry.key) ?? 0,
      })),
      // The other half: a child still sitting at an index its own array
      // disagrees with, across two consecutive batches.
      misplaced: confirmed,
      // The batch that did it, and what the list was doing just before.
      batch,
      priorBatches: history.slice(0, -1),
      domChildren: list.children.length,
      itemCount: keys.length,
      firstItemIndex: panel.firstItemIndex(),
      // Height is the reason any of this matters, and it is readable without the
      // fiber walk: what the box measures against what its own padding plus its
      // children come to.
      listHeight: Math.round(list.getBoundingClientRect().height),
      recordNumber: recorded,
    })
  })

  observer.observe(list, { childList: true })
  return () => observer.disconnect()
}
