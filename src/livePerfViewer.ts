// The viewer tag every live-perf payload carries, so samples from Skip's
// browser stay separable from agent browsers.
//
// The source is the fleet identity — the same `getHumanId`/`getHumanName` the
// viewing heartbeat and chat `from` stamps use — not a parallel reader of the
// storage underneath it. Read at send time: identity resolves asynchronously
// (login/register round-trip after mount), so a value captured at probe
// install would be null for the early samples of every session.
//
// This lives apart from the upload transport (`livePerfUpload.ts`) on purpose:
// the transport stays dependency-free so the Node upload test keeps running
// without the fleet graph, and callers in the viewer bundle tag their
// payloads here instead.

import { getHumanId, getHumanName } from './fleet/fleet-data.mjs'

export type LivePerfViewer = {
  id: string | null
  name: string | null
}

export function readLivePerfViewer(): LivePerfViewer {
  try {
    return {
      id: getHumanId() ?? null,
      name: getHumanName() ?? null,
    }
  } catch {
    return { id: null, name: null }
  }
}
