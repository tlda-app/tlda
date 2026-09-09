import type { GradingStatus } from './api'

// The words a person reads. The stored states stay `ungraded → graded →
// returned`; these are the labels rendered over them.
//
// Skip retired the evaluation vocabulary on 2026-09-03 — "this is a teaching
// app, not an evaluation app", "yes plz stop using the word grade". The states
// are not renamed here because a rename in a live path is a real change; the
// labels are, because a label is the only place that ruling is visible to the
// person reading the page.
//
// Status only. Nothing here counts points, and there is nothing to add one to.

export type CellState = GradingStatus | 'not-submitted'

const CELL_LABELS: Record<CellState, string> = {
  'not-submitted': 'Not handed in',
  ungraded: 'Handed in',
  graded: 'Marked',
  returned: 'Returned',
}

export function cellLabel(state: string): string {
  return CELL_LABELS[state as CellState] ?? state
}

// What a student sees about their own single submission. "Handed in" is the
// honest word before it has been looked at: the earlier label said `ungraded`,
// which reads as a verdict rather than a stage.
export function submissionLabel(status: GradingStatus): string {
  return cellLabel(status)
}

// The counts across a set of cells. `missing` is the store's key for a cell
// with no submission behind it.
export const COUNT_LABELS: Record<string, string> = {
  missing: 'not handed in',
  ungraded: 'awaiting marking',
  graded: 'marked',
  returned: 'returned',
}

export function countLabel(key: string): string {
  return COUNT_LABELS[key] ?? key
}
