/**
 * outline-schema.mjs — prop validators for the `outline` custom shape, imported
 * by BOTH the client util (src/shapes/OutlineShape.tsx) and the server sync
 * schema (server/lib/sync-rooms.mjs). Must match exactly or @tldraw/sync throws
 * a TLSyncError and crashes the room. Shared object = identical by construction.
 *
 * The shape is a thin front-end over the move-only token model: it renders the
 * id-tagged outline (GET /:doc/outline-model?slug) as markdown rows with drag
 * handles, and applies reorder/insert/delete via POST /:doc/outline-apply. The
 * model itself is the source of truth — the shape stores only its binding
 * (doc, slug) and view box.
 */

import { T } from '@tldraw/validate'

export const outlineProps = {
  w: T.number,
  h: T.number,
  doc: T.string,
  slug: T.string,
}
