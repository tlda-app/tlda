export interface HtmlHeadingOutlineEntry {
  id: string
  title: string
  level: number
}

const outlines = new Map<string, HtmlHeadingOutlineEntry[]>()
const listeners = new Set<(shapeId: string) => void>()

export function setHtmlHeadingOutline(shapeId: string, outline: HtmlHeadingOutlineEntry[]) {
  outlines.set(shapeId, outline)
  for (const listener of listeners) listener(shapeId)
}

export function getHtmlHeadingOutline(shapeId: string | undefined) {
  return shapeId ? outlines.get(shapeId) ?? null : null
}

export function subscribeHtmlHeadingOutline(listener: (shapeId: string) => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function clearHtmlHeadingOutline(shapeId: string) {
  outlines.delete(shapeId)
}
