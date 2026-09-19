import { useEffect, useMemo, useState } from 'react'
import { react, type Editor } from 'tldraw'

import { markingInkFrame, type MarkingInkFrame } from './markingInkFrame'

/**
 * The answer's box beside the solution, in the chapter's own coordinates.
 *
 * `GAP` and `WIDTH` are the margin-left and max-width the answer had when it
 * was positioned by the chapter's stylesheet, so the place it lands is the
 * place it landed before — the move to the parent is meant to make it readable,
 * not to relocate it.
 */
const ANSWER_GAP = 24
const ANSWER_WIDTH = 512

export interface InkFrame extends MarkingInkFrame {
  /** The answer's own screen box, for the pane that renders it. */
  answerBounds: { left: number; top: number; width: number; height: number }
}

/**
 * Keep an ink pane's frame over a solution/answer pair.
 *
 * Extracted from `MarkingInkOverlay`, which had the only copy, so the local
 * layer can have the same frame instead of no frame at all. It had none: its
 * glass was rendered with neither `bounds` nor `camera`, so it fell back to the
 * stylesheet's `position: absolute; inset: 0` and took its geometry from
 * whatever it happened to be mounted in. Mounted inside `.bottom-panels` —
 * `position: fixed` with only `bottom` and `left`, so a 0×0 box — the pane
 * resolved to 0×0 and every stroke fell through to the book's own canvas and
 * into the shared chapter room that every reader sees.
 *
 * THE FRAME IS WHY THAT CANNOT RECUR. `bounds` positions the pane `fixed` in
 * screen coordinates, so it does not ask its parent for a size and cannot be
 * broken by being moved again; `camera` puts page zero at the WRAPPER's
 * top-left, so a stroke is stored relative to the pair rather than to the page.
 * Skip: "the glass can be an infinite pane", "it's not that it's bounded
 * extent", "its origin is just relative to like, the callout. like top-left is
 * origin or whatever" — the extent here is only the painted surface; the
 * coordinate frame it hands the store has an origin and no size.
 *
 * Re-measured on anything that can move the pair — its own resize, the iframe's,
 * the editor container's, a mutation inside it, the book's camera, a window
 * resize, and any scroll in the capture phase — because the painted surface has
 * to follow the callout even though the stored coordinates do not. The answer
 * itself is no longer among them: it is in the parent now, and its box is
 * chosen here rather than read off an element.
 */
export function useInkFrame(
  wrapper: HTMLElement | null,
  answerHeight: number,
  editor: Editor | null,
): InkFrame | null {
  const measure = useMemo(() => () => {
    if (!wrapper?.isConnected || !editor) return null
    const frame = wrapper.ownerDocument.defaultView?.frameElement
    if (!(frame instanceof HTMLIFrameElement)) return null
    const container = editor.getContainer()
    const wrapperRect = wrapper.getBoundingClientRect()

    // THE ANSWER'S BOX IS CHOSEN, NOT MEASURED, and that is what keeps a stroke
    // where it was stored. The answer is not in this document any more — it is
    // in the parent, where nothing clips it — so there is no element here to
    // ask. Naming the box in the chapter's coordinates instead means
    // `markingInkFrame` receives exactly what it received when the answer WAS
    // here, and the camera it returns is unchanged by construction.
    //
    // Its top is the SOLUTION's, not the wrapper's. The wrapper's box is the
    // solution's margin box — measured 21px taller — so aligning to it is the
    // tops-aligned failure this layout already paid for once.
    const solution = wrapper.firstElementChild
    const top = solution ? solution.getBoundingClientRect().top : wrapperRect.top
    const left = wrapperRect.right + ANSWER_GAP
    const answer = {
      left,
      top,
      right: left + ANSWER_WIDTH,
      bottom: top + answerHeight,
      width: ANSWER_WIDTH,
      height: answerHeight,
    }

    const inkFrame = markingInkFrame({
      wrapper: wrapperRect,
      answer,
      iframe: frame.getBoundingClientRect(),
      container: container.getBoundingClientRect(),
      iframeClientWidth: frame.clientWidth,
      iframeOffsetWidth: frame.offsetWidth,
      iframeClientLeft: frame.clientLeft,
      iframeClientTop: frame.clientTop,
    })
    if (!inkFrame) return null

    // The pane's screen box comes off the SAME frame the glass is placed by, so
    // the ink cannot drift from the answer it is drawn on: both are this one
    // conversion, read twice.
    const scale = inkFrame.camera.z
    return {
      ...inkFrame,
      answerBounds: {
        left: inkFrame.bounds.left + (answer.left - Math.min(wrapperRect.left, answer.left)) * scale,
        top: inkFrame.bounds.top + (answer.top - Math.min(wrapperRect.top, answer.top)) * scale,
        width: answer.width * scale,
        height: answer.height * scale,
      },
    }
  }, [wrapper, answerHeight, editor])

  const [frame, setFrame] = useState<InkFrame | null>(measure)

  useEffect(() => {
    if (!wrapper || !editor) { setFrame(null); return }
    let animation = 0
    const update = () => {
      animation = 0
      const next = measure()
      setFrame(current => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    }
    const schedule = () => {
      if (!animation) animation = window.requestAnimationFrame(update)
    }
    const iframe = wrapper.ownerDocument.defaultView?.frameElement
    const resize = new ResizeObserver(schedule)
    resize.observe(wrapper)
    if (iframe instanceof HTMLElement) resize.observe(iframe)
    resize.observe(editor.getContainer())
    const mutations = new MutationObserver(schedule)
    mutations.observe(wrapper, { subtree: true, childList: true, attributes: true })
    const stopCamera = react('place ink pane over pair', () => {
      editor.getCamera()
      schedule()
    })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    schedule()
    return () => {
      stopCamera()
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      if (animation) window.cancelAnimationFrame(animation)
    }
  }, [wrapper, editor, measure])

  return frame
}
