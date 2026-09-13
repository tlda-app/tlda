/**
 * Edit bridge layout and hand-off payload — the parts with no React and no
 * browser in them.
 *
 * Separated from the hook so the arithmetic that decides where a card sits,
 * and the brief that carries a person's judgment to an agent, can be exercised
 * directly. Inside the hook they could only be reached by importing the shape
 * modules, which need a served page to load at all.
 */

import { EDIT_CARD_H, EDIT_CARD_W } from '../../shared/edit-card-metrics.mjs'

const CARD_GAP_X = 40
const CARD_GAP_Y = 24

export { CARD_GAP_X, CARD_GAP_Y }

export interface BridgeEditor {
  agentId: string
  name: string | null
  taskId: string | null
  files: string[]
}

/** What an edit did to the writing, summarised by the server. */
export interface BridgeChange {
  kind: 'addition' | 'deletion' | 'replacement'
  addedWords: number
  removedWords: number
  rewordedWords: number
  hunkCount: number
  excerpt: {
    file: string | null
    before: string
    after: string
    beforeParts?: { text: string; changed: boolean }[]
    afterParts?: { text: string; changed: boolean }[]
  } | null
}

export interface BridgeBuild {
  hash: string
  timestamp: number
  message: string
  files: string[]
  editors: BridgeEditor[]
  change: BridgeChange | null
}

/**
 * Where the bridge's cards go, in the gap the widened compare opens up.
 *
 * ONE COLUMN, in order. Consecutive builds are always neighbours, and that is
 * the property the layout exists to have: §7 asks a person to perceive
 * "repeated attempts", "corrections", and "places where later edits partially
 * undo earlier ones", and none of those can be seen if the two cards are not
 * next to each other.
 *
 * This wrapped every six cards until a photographer checked it. On a
 * seven-build interval the revert pair was builds six and seven -- the bottom
 * of the first column and the top of the second, about 1,460px apart
 * diagonally -- so the one relationship in that history worth seeing was the
 * one the layout had pulled apart. The wrap was mine and it was for
 * compactness; the spec's own picture of a bridge is a line, not a grid.
 */
export function cardLayout(index: number, originX: number, originY: number) {
  return {
    x: originX,
    y: originY + index * (EDIT_CARD_H + CARD_GAP_Y),
  }
}

/** The extra width the compare column moves out by to make room for cards. */
export function bridgeGapWidth(count: number): number {
  if (count <= 0) return 0
  return EDIT_CARD_W + CARD_GAP_X * 2
}

/**
 * The cleanup brief: the interval, and what a person said about it.
 *
 * This is the payload the whole feature exists to produce -- the point is that
 * a person supplies judgment cheaply and an agent does the integration, so
 * what leaves here has to carry the judgment and enough context to act on it:
 * which versions, which builds, which files, who edited them, and the note.
 *
 * Builds nobody annotated are listed without commentary rather than dropped.
 * An interval is a sequence, and an agent told only about the annotated builds
 * would be reading a different history from the one the person looked at.
 */
export function buildCleanupBrief(
  from: string,
  to: string,
  builds: BridgeBuild[],
  notes: Map<string, string>,
): string {
  const lines = [
    `Clean up the interval \`${from.slice(0, 7)}..${to.slice(0, 7)}\` using these annotations.`,
    '',
    `${builds.length} build${builds.length === 1 ? '' : 's'} between the two versions, oldest first.`,
    '',
  ]
  for (const build of builds) {
    const who = build.editors.length
      ? build.editors.map(e => e.name || e.agentId).join(', ')
      : 'no recorded author'
    lines.push(`- \`${build.hash.slice(0, 7)}\` ${new Date(build.timestamp).toISOString()} — ${who}`)
    if (build.files.length) lines.push(`  files: ${build.files.join(', ')}`)
    // What it did, not only where. An agent asked to clean up an interval from
    // a list of filenames has to go and diff every build itself, which is the
    // bookkeeping this feature exists to take off a person -- handing it
    // straight back to the agent is no better.
    if (build.change) {
      const c = build.change
      lines.push(c.kind === 'replacement'
        ? `  rewrote ~${c.rewordedWords} words (+${c.addedWords}/-${c.removedWords})`
        : `  ${c.kind}: +${c.addedWords}/-${c.removedWords} words`)
      if (c.excerpt?.before) lines.push(`    was: ${c.excerpt.before}`)
      if (c.excerpt?.after) lines.push(`    now: ${c.excerpt.after}`)
    }
    const note = notes.get(build.hash)?.trim()
    if (note) lines.push(`  note: ${note}`)
  }
  return lines.join('\n')
}

