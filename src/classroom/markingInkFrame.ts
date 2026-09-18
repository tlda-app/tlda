export interface RectLike {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface MarkingInkFrame {
  bounds: { left: number; top: number; width: number; height: number }
  camera: { x: number; y: number; z: number }
  wrapperTransform: { x: number; y: number; scale: number }
}

export function markingInkLayerId(contentRef: string, exerciseId: string) {
  return `wm:grading-ink:${contentRef}:${exerciseId}`
}

const union = (a: RectLike, b: RectLike): RectLike => {
  const left = Math.min(a.left, b.left)
  const top = Math.min(a.top, b.top)
  const right = Math.max(a.right, b.right)
  const bottom = Math.max(a.bottom, b.bottom)
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

/**
 * Express the visible pair in the editor container while retaining the pair
 * wrapper as the stored-coordinate origin.
 *
 * The answer is absolutely positioned and therefore does not enlarge the
 * wrapper's DOM rect. The capture bounds are their visual union; the camera
 * offset is what keeps shape coordinates relative to the wrapper rather than
 * relative to that larger capture rectangle.
 */
export function markingInkFrame({
  wrapper,
  answer,
  iframe,
  container,
  iframeClientWidth,
  iframeOffsetWidth,
  iframeClientLeft = 0,
  iframeClientTop = 0,
}: {
  wrapper: RectLike
  answer: RectLike
  iframe: RectLike
  container: RectLike
  iframeClientWidth: number
  iframeOffsetWidth: number
  iframeClientLeft?: number
  iframeClientTop?: number
}): MarkingInkFrame | null {
  if (iframeClientWidth <= 0 || iframeOffsetWidth <= 0) return null
  const scale = iframe.width / iframeOffsetWidth
  if (!Number.isFinite(scale) || scale <= 0) return null

  const visible = union(wrapper, answer)
  const contentLeft = iframe.left + iframeClientLeft * scale
  const contentTop = iframe.top + iframeClientTop * scale
  const visibleLeft = contentLeft + visible.left * scale
  const visibleTop = contentTop + visible.top * scale
  const wrapperLeft = contentLeft + wrapper.left * scale
  const wrapperTop = contentTop + wrapper.top * scale

  return {
    bounds: {
      left: visibleLeft,
      top: visibleTop,
      width: visible.width * scale,
      height: visible.height * scale,
    },
    // Tldraw maps page -> screen as (page + camera) * zoom. The canvas begins
    // at the union's top-left, while page zero is the wrapper's top-left.
    camera: {
      x: wrapper.left - visible.left,
      y: wrapper.top - visible.top,
      z: scale,
    },
    wrapperTransform: {
      x: wrapperLeft - container.left,
      y: wrapperTop - container.top,
      scale,
    },
  }
}
