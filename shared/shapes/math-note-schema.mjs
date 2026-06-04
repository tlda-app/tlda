/**
 * math-note-schema.mjs — the prop validators for the `math-note` custom shape,
 * imported by BOTH the client shape util (src/shapes/MathNoteShape.tsx) and the
 * server sync schema (server/lib/sync-rooms.mjs).
 *
 * Custom shape props must match EXACTLY on client and server or @tldraw/sync
 * throws a TLSyncError that crashes the room for everyone. They had drifted:
 * the server schema carried `tabs`/`activeTab` (note threading) that the client
 * had dropped. Sharing one props object makes them identical by construction.
 *
 * This is the superset (tabs/activeTab kept as optional). They are unused by
 * the current client but are NOT removed: dropping an optional prop validator
 * would reject any existing note record that still carries it. Optional+unused
 * is harmless and zero-risk for live data.
 *
 * Imports the @tldraw sub-packages (not the `tldraw` meta-package) so the module
 * resolves in both the Node server and the Vite client bundle.
 */

import { T } from '@tldraw/validate'
import { DefaultColorStyle } from '@tldraw/tlschema'

export const mathNoteProps = {
  w: T.number,
  h: T.number,
  text: T.string,
  color: DefaultColorStyle,
  autoSize: T.optional(T.boolean),
  choices: T.optional(T.arrayOf(T.string)),
  selectedChoice: T.optional(T.number),
  tabs: T.optional(T.arrayOf(T.string)),
  activeTab: T.optional(T.number),
  done: T.optional(T.boolean),
  collapsed: T.optional(T.boolean),
  docName: T.optional(T.string),
  docView: T.optional(T.boolean),
  backingFile: T.optional(T.string),
}
