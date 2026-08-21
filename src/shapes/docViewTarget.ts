import type { TLShapeId } from 'tldraw'

type DocumentPage = { shapeId?: string }

export function resolveDocViewTargetShapeId({
  format,
  pages,
  page,
  explicitTargetShapeId,
}: {
  format?: string
  pages: DocumentPage[]
  page: number
  explicitTargetShapeId?: string
}): TLShapeId | '' {
  if (explicitTargetShapeId) return explicitTargetShapeId as TLShapeId
  if (format !== 'html' || pages.length === 0) return ''

  const requestedPage = Number.isInteger(page) && page > 0 ? pages[page - 1] : undefined
  return (requestedPage?.shapeId || pages[0]?.shapeId || '') as TLShapeId | ''
}
