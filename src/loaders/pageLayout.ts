import { Box } from 'tldraw'

export type PageLayoutAxis = 'horizontal' | 'vertical'

export function layoutPageBounds(
  pages: Array<{ width: number; height: number }>,
  axis: PageLayoutAxis,
  gap: number,
): Box[] {
  let offset = 0
  const crossSize = Math.max(0, ...pages.map(page =>
    axis === 'horizontal' ? page.height : page.width
  ))

  return pages.map(page => {
    const bounds = axis === 'horizontal'
      ? new Box(offset, (crossSize - page.height) / 2, page.width, page.height)
      : new Box((crossSize - page.width) / 2, offset, page.width, page.height)
    offset += (axis === 'horizontal' ? page.width : page.height) + gap
    return bounds
  })
}
