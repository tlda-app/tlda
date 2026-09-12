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
/** How many cards stack vertically before the next column of cards starts. */
const CARDS_PER_COLUMN = 6

export { CARD_GAP_X, CARD_GAP_Y, CARDS_PER_COLUMN }

export interface BridgeEditor {
  agentId: string
  name: string | null
  taskId: string | null
  files: string[]
}

export interface BridgeBuild {
  hash: string
  timestamp: number
  message: string
  files: string[]
  editors: BridgeEditor[]
}

/** Where the bridge's cards go, in the gap the widened compare opens up. */
export function cardLayout(index: number, originX: number, originY: number) {
  const column = Math.floor(index / CARDS_PER_COLUMN)
  const row = index % CARDS_PER_COLUMN
  return {
    x: originX + column * (EDIT_CARD_W + CARD_GAP_X),
    y: originY + row * (EDIT_CARD_H + CARD_GAP_Y),
  }
}

/** The extra width the compare column moves out by to make room for `count` cards. */
export function bridgeGapWidth(count: number): number {
  if (count <= 0) return 0
  const columns = Math.ceil(count / CARDS_PER_COLUMN)
  return columns * (EDIT_CARD_W + CARD_GAP_X) + CARD_GAP_X
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
    const note = notes.get(build.hash)?.trim()
    if (note) lines.push(`  note: ${note}`)
  }
  return lines.join('\n')
}

