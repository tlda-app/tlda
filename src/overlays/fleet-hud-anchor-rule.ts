// Whether a stored HUD anchor is still a position.
//
// Extracted from FleetHUD.tsx because it cannot be exercised there — the file
// pulls in tldraw and will not load outside a browser — and because the thing
// it decides is invisible on a fresh profile. Panels created moments before a
// gate carry fresh anchors, so a candidate that forgets stored ones passes the
// gate and fails for everyone who has used the surface before.

import type { Axis } from '../shapes/document-flow-axis'

/**
 * The placement rule a stored anchor was written under, per flow axis.
 *
 * An anchor is two numbers whose meaning comes entirely from the rule that
 * computed them. When that rule changes the numbers do not become
 * wrong-looking — they stay perfectly readable and mean something else, which
 * is worse. That is how a layout ends up below the slide it should sit above.
 *
 * **Per axis, because placement changes are per axis.** One global name forces
 * a choice with a cost either way: bump it and every paper anchor is discarded
 * along with the deck ones, on documents whose placement never moved; leave it
 * and an existing deck keeps the offscreen position the change exists to
 * repair. Neither is what the change means.
 *
 * This is the same reasoning `b81326d6a` used when it added the per-anchor
 * `axis` tag rather than bumping: invalidate exactly the anchors whose rule
 * actually changed. A deck's placement moved from above the top edge to along
 * it, so `x` gets a new name and `y` keeps the one it had.
 *
 * Bump the name for an axis whenever that axis's placement rule changes.
 */
export const ANCHOR_RULES: Record<Axis, string> = {
  y: 'flow-axis-1',
  x: 'deck-top-1',
}

export interface StoredAnchor {
  panOffset: number
  cameraY: number
}

/**
 * Read a stored anchor, or `null` if it is not a position any more.
 *
 * Two guards, doing different jobs, and both are needed:
 *
 * - **the axis** rejects an anchor whose document changed shape underneath it.
 *   A deck used to be one page shape per slide running down and is now one
 *   running across; an anchor computed under `y` is not a position under `x`.
 * - **the per-axis rule** rejects one whose placement rule changed while the
 *   document's shape stayed the same. That is this change: decks moved from
 *   above the top edge to along it.
 *
 * The rule is checked against the axis the anchor was WRITTEN under, not the
 * document's current one — an anchor carries its own provenance, and one caller
 * has no flow axis to pass. An anchor with no axis predates the tag and is
 * treated as `y`, which is what every document was.
 */
export function readStoredAnchor(meta: unknown, flowAxis: Axis | null): StoredAnchor | null {
  const record = meta as { panOffset?: number; cameraY?: number; rule?: string; axis?: Axis } | null
  if (!record || record.panOffset === undefined) return null
  const writtenAxis: Axis = record.axis ?? 'y'
  if (record.rule !== ANCHOR_RULES[writtenAxis]) return null
  if (flowAxis && writtenAxis !== flowAxis) return null
  return { panOffset: record.panOffset, cameraY: record.cameraY as number }
}
