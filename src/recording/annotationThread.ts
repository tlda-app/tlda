/**
 * Reading a thread back: finding an answer's layers, and playing one path.
 *
 * The model is `shared/annotation-thread.mjs`; this is the part that talks to
 * the recording store and to a playback engine. See docs/annotation-threads.md.
 *
 * Nothing here decides who may read a layer or when one is returned. A layer is
 * fetched through the same private-draft route a lecture is, so this adds no
 * reader that `classroomRooms`' authority did not already admit.
 */

import {
  composeAlongPath,
  layerPath,
  threadLayers,
  threadRoots,
  repliesTo,
} from '../../shared/annotation-thread.mjs'
import type { AnswerRef, ParentRef } from './recorder'
import {
  getRecording,
  listRecordingDraftsIncludingLayers,
  type RecordingSummary,
} from './recordingApi'

/** A layer as the listing knows it: enough to build the tree, not to play it. */
export interface ThreadLayerSummary extends RecordingSummary {
  answer?: AnswerRef
  parentLayerId?: string
}

/** What `layerPath` and `composeAlongPath` need of a layer. */
interface PathLayer {
  id: string
  parent: { layerId: string; warp: ParentRef['warp'] } | null
}

/**
 * The layers of one student's answer to one problem, newest first.
 *
 * A thread is derived, not registered: it is every layer carrying this address,
 * and its shape is the parent pointers those layers already hold.
 */
export async function listThread(doc: string, answer: AnswerRef): Promise<ThreadLayerSummary[]> {
  const recordings = (await listRecordingDraftsIncludingLayers(doc)) as ThreadLayerSummary[]
  return threadLayers(recordings, answer) as ThreadLayerSummary[]
}

/** The layers of a thread that answer nothing, and those answering a given one. */
export { threadRoots, repliesTo }

/**
 * Load a root-to-leaf path with every warp along it.
 *
 * Each layer is fetched in full, because playing a path drives every layer on
 * it: the leaf's audio runs on its own clock and each ancestor is seeked to
 * where that clock says it was.
 */
export async function loadPath(
  doc: string,
  layers: ThreadLayerSummary[],
  leafId: string,
): Promise<PathLayer[]> {
  // The listing carries the tree's shape but not its warps, which is all
  // `layerPath` needs to find the path; the warps come from the layers
  // themselves, fetched below.
  const shape = layers.map((l) => ({
    id: l.id,
    parent: l.parentLayerId ? { layerId: l.parentLayerId } : null,
  }))
  const path: { id: string }[] = layerPath(shape, leafId)

  const loaded = await Promise.all(path.map((l) => getRecording(doc, l.id, true)))
  return path.map((l, i) => {
    const meta = loaded[i]
    if (!meta) {
      throw new Error(
        `Layer ${l.id} is on the path to ${leafId} in ${doc}, but no recording is stored for it`,
      )
    }
    return { id: l.id, parent: meta.parent ?? null }
  })
}

/** Something a layer's time can be driven to — a `PlaybackEngine`, in practice. */
export interface Seekable {
  seek(ms: number): void
}

/**
 * Put every layer on the path where `t` on the leaf says it should be.
 *
 * This is what the warp is for. Playing a reply is its own audio on its own
 * clock, with the warp driving the parent's playhead — so pausing on an answer
 * to talk over it, and scrubbing back to something the student did earlier, are
 * both just points on this path rather than cases anything has to handle.
 *
 * `seeks` is aligned with `path`, root first. Returns the times used, so a
 * caller can show where each layer sits without composing them twice.
 */
export function driveThreadPath(
  path: PathLayer[],
  seeks: (Seekable | null | undefined)[],
  t: number,
): number[] {
  const times = composeAlongPath(path, t)
  for (let i = 0; i < path.length; i++) seeks[i]?.seek(times[i])
  return times
}
