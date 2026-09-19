import { useEffect, useMemo, useState } from 'react'
import { react, type Editor } from 'tldraw'

import { markingInkFrame, type MarkingInkFrame } from './markingInkFrame'

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
 * Re-measured on anything that can move the pair — its own resize, the answer's,
 * the iframe's, the editor container's, a mutation inside it, the book's camera,
 * a window resize, and any scroll in the capture phase — because the painted
 * surface has to follow the callout even though the stored coordinates do not.
 */
export function useInkFrame(
  wrapper: HTMLElement | null,
  answerSelector: string,
  editor: Editor | null,
): MarkingInkFrame | null {
  const measure = useMemo(() => () => {
    if (!wrapper?.isConnected || !editor) return null
    const answer = wrapper.querySelector<HTMLElement>(answerSelector)
    const frame = wrapper.ownerDocument.defaultView?.frameElement
    if (!answer || !(frame instanceof HTMLIFrameElement)) return null
    const container = editor.getContainer()
    return markingInkFrame({
      wrapper: wrapper.getBoundingClientRect(),
      answer: answer.getBoundingClientRect(),
      iframe: frame.getBoundingClientRect(),
      container: container.getBoundingClientRect(),
      iframeClientWidth: frame.clientWidth,
      iframeOffsetWidth: frame.offsetWidth,
      iframeClientLeft: frame.clientLeft,
      iframeClientTop: frame.clientTop,
    })
  }, [wrapper, answerSelector, editor])

  const [frame, setFrame] = useState<MarkingInkFrame | null>(measure)

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
    const answer = wrapper.querySelector<HTMLElement>(answerSelector)
    const iframe = wrapper.ownerDocument.defaultView?.frameElement
    const resize = new ResizeObserver(schedule)
    resize.observe(wrapper)
    if (answer) resize.observe(answer)
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
  }, [wrapper, answerSelector, editor, measure])

  return frame
}
