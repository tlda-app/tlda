/**
 * recordingApi.ts — client helpers for the recording REST endpoints.
 * Shared by the recorder (M1) and the playback scrubber (M2).
 */

import type { RecordingMeta } from './recorder'

export function getServerHttpBase(): string {
  return (window as any).__tlda_server || window.location.origin
}

export interface RecordingSummary {
  id: string
  title: string
  created: string
  duration_ms: number
  privateDraft?: boolean
  publication?: { state: 'candidate-clip'; startMs: number; endMs: number } | null
}

/** List recordings for a doc, newest first. */
export async function listRecordings(doc: string): Promise<RecordingSummary[]> {
  const resp = await fetch(`${getServerHttpBase()}/api/projects/${doc}/recordings`)
  if (!resp.ok) return []
  const data = await resp.json()
  return data.recordings ?? []
}

/**
 * Every private draft, including the layers of answer threads.
 *
 * `listRecordingDrafts` is the lecture list and filters those out; this is for
 * a caller that wants them. See `annotationThread.ts`.
 */
export async function listRecordingDraftsIncludingLayers(doc: string): Promise<RecordingSummary[]> {
  const resp = await fetch(`${getServerHttpBase()}/api/projects/${doc}/recording-drafts`)
  if (!resp.ok) return []
  const data = await resp.json()
  return (data.recordings ?? []).map((recording: RecordingSummary) => ({ ...recording, privateDraft: true }))
}

/**
 * The lectures among the private drafts.
 *
 * A thread layer is stored as a recording — it is ink on a clock with one audio
 * track, which is what a recording is — so the directory this reads now holds
 * two kinds of thing where it used to hold one. Without this filter the meaning
 * of every existing caller's list would have changed underneath it, and marking
 * a student's answer would put that answer in the lecture picker.
 */
export async function listRecordingDrafts(doc: string): Promise<RecordingSummary[]> {
  const all = await listRecordingDraftsIncludingLayers(doc)
  return all.filter((recording) => !(recording as { answer?: unknown }).answer)
}

/** Fetch a recording's full metadata + events. */
export async function getRecording(doc: string, id: string, privateDraft = false): Promise<(RecordingMeta & { privateDraft?: boolean; publication?: RecordingSummary['publication'] }) | null> {
  const path = privateDraft ? `recording-draft/${id}` : `recording/${id}`
  const resp = await fetch(`${getServerHttpBase()}/api/projects/${doc}/${path}`)
  if (!resp.ok) return null
  return resp.json()
}

/** URL for a recording's audio blob (feed straight to an <audio> element). */
export function recordingAudioUrl(doc: string, id: string, privateDraft = false): string {
  const path = privateDraft ? `recording-draft/${id}` : `recording/${id}`
  return `${getServerHttpBase()}/api/projects/${doc}/${path}/audio`
}

/**
 * Propose the class interval as the owner.
 *
 * The agent path for this is a fleet-websocket message that only an
 * authenticated fleet agent may send, so without this the owner's own review
 * step refused until somebody else ran an MCP call. Same server function, owner
 * as the actor.
 */
export async function proposeClassInterval(doc: string, id: string, startMs: number, endMs: number) {
  const resp = await fetch(`${getServerHttpBase()}/api/projects/${doc}/recording/${id}/propose-interval`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startMs, endMs }),
  })
  if (!resp.ok) throw new Error((await resp.json()).error || `Interval proposal failed (${resp.status})`)
  return resp.json()
}

export async function editOwnerClassInterval(doc: string, id: string, startMs: number, endMs: number) {
  const resp = await fetch(`${getServerHttpBase()}/api/projects/${doc}/recording/${id}/owner-interval`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startMs, endMs }),
  })
  if (!resp.ok) throw new Error((await resp.json()).error || `Boundary edit failed (${resp.status})`)
  return resp.json()
}

export async function publishClassInterval(doc: string, id: string) {
  const resp = await fetch(`${getServerHttpBase()}/api/projects/${doc}/recording/${id}/publish`, { method: 'POST' })
  if (!resp.ok) throw new Error((await resp.json()).error || `Publication failed (${resp.status})`)
  return resp.json()
}
