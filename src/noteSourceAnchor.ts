/**
 * The one place a sticky note gets its source anchor.
 *
 * Every note is anchored where it lands, at the moment it is created, by the
 * creator that places it — the note tool, the voice tool, and every drop path.
 * Resolve first, then create: a note is never written to the store without its
 * anchor and then repaired afterwards, because nothing observes or retries that
 * repair (the defect this replaced in VoiceNoteTool).
 */
import type { Editor } from 'tldraw'
import { currentDocumentInfo } from './svgDocumentLoader'
import { annotationSourceAnchorAtCanvasPoint, type AnnotationSourceAnchor } from './annotationSourceAnchor'

/**
 * Meta fragment carrying the note's anchor, to spread into `meta` at creation.
 * Empty when there is no document loaded or the point resolves to no source —
 * an absent anchor, not a false one.
 */
export async function noteSourceAnchorMeta(
  editor: Editor,
  x: number,
  y: number,
): Promise<{ sourceAnchor?: AnnotationSourceAnchor }> {
  if (!currentDocumentInfo) return {}
  try {
    const anchor = await annotationSourceAnchorAtCanvasPoint(editor, currentDocumentInfo, x, y)
    return anchor ? { sourceAnchor: anchor } : {}
  } catch (e) {
    console.warn('[Anchor] note source anchor lookup failed:', (e as Error).message)
    return {}
  }
}

export function annotationAnchorLabel(anchor: AnnotationSourceAnchor): string {
  if (anchor.anchored === false) return anchor.reason
  return `${anchor.file}:${anchor.line}`
}
