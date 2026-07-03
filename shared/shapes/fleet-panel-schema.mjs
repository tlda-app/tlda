/**
 * Prop validators for fleet panel custom shapes, imported by BOTH the client
 * shape utils and the server sync schema. Custom shape props must match exactly
 * on both sides or @tldraw/sync throws a TLSyncError for the room.
 */

import { T } from '@tldraw/validate'

const ownedPanelProps = {
  w: T.number,
  h: T.number,
  userId: T.optional(T.string),
  deviceId: T.optional(T.string),
}

export const fleetChatProps = {
  ...ownedPanelProps,
  filter: T.arrayOf(T.arrayOf(T.arrayOf(T.string))),
  trafficMode: T.optional(T.string),
}

export const fleetAgentsProps = ownedPanelProps
export const fleetSearchProps = ownedPanelProps
export const fleetInboxProps = ownedPanelProps
export const fleetNotificationsProps = ownedPanelProps
export const fleetTouchInboxProps = ownedPanelProps
export const fleetReaperProps = ownedPanelProps

export const fleetDocviewProps = {
  ...ownedPanelProps,
  mode: T.optional(T.string),
  label: T.string,
  page: T.number,
  yTop: T.number,
  yBottom: T.number,
  title: T.string,
  sources: T.optional(T.string),
}

export const fleetSourceEditorProps = {
  ...ownedPanelProps,
  file: T.string,
  line: T.number,
  title: T.string,
}
