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

export async function listRecordingDrafts(doc: string): Promise<RecordingSummary[]> {
  const resp = await fetch(`${getServerHttpBase()}/api/projects/${doc}/recording-drafts`)
  if (!resp.ok) return []
  const data = await resp.json()
  return (data.recordings ?? []).map((recording: RecordingSummary) => ({ ...recording, privateDraft: true }))
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
