/**
 * Starting a reply: what a plus does.
 *
 * Skip: *"its a thread anyone can reply to anything"*, and every reply happens
 * on **a new layer, on top of the previous thing**. So a reply is not an
 * annotation of its parent — it is its own layer stacked over the one it
 * answers, and nothing composites down into the parent.
 *
 * The one decision here is what a plus replies *to*, and it is decided by what
 * you are looking at rather than by a picker: **press it while a layer is
 * playing and you reply to that layer; press it with nothing playing and you
 * start the answer's first layer.** That is what makes "reply to anything"
 * reachable without asking anyone to choose from a list — to reply to an
 * earlier layer you play that layer and press plus there.
 *
 * Replying to a playing layer is also the only moment the warp can be recorded,
 * because the warp is where its playhead actually was while you talked over it.
 */

import type { AnswerRef, LayerOptions } from '../recording/recorder'

/** A layer open in front of the reader, and where its playhead sits. */
export interface PlayingLayer {
  layerId: string
  /** Read at the instant the warp samples it, not a snapshot taken now. */
  currentMs: () => number
}

/**
 * What the next layer on this answer replies to.
 *
 * Returns the options `startRecording` needs. With nothing playing there is no
 * parent and therefore no warp — a root layer has nothing to be warped onto,
 * which is also the shape of a mark that is simply made rather than answered.
 */
export function replyTarget(answer: AnswerRef, playing?: PlayingLayer | null): LayerOptions {
  if (!playing) return { answer }
  return {
    answer,
    parentLayerId: playing.layerId,
    parentTime: playing.currentMs,
  }
}

/**
 * Whether pressing plus now would answer something or begin the thread.
 *
 * The control says which of the two it is about to do, because "reply" and
 * "start marking" are different acts and the difference is invisible otherwise
 * — the plus looks identical either way.
 */
export function replyKind(playing?: PlayingLayer | null): 'reply' | 'first' {
  return playing ? 'reply' : 'first'
}
