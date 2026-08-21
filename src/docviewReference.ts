import type { Editor } from 'tldraw'
import type { BuildError } from './useYjsSync'
import { loadLookup } from './synctexLookup'
import { lookupSourceLine, SYNCTEX_VIEWBOX_OFFSET } from './synctexAnchor'
import { PDF_HEIGHT } from './layoutConstants'
import { buildErrorReferenceFromPosition, updateReferenceDocviews } from '../shared/docview-reference.mjs'

export interface DocviewReference {
  label: string
  page: number
  yTop: number
  yBottom: number
  title: string
}

export { updateReferenceDocviews }

export async function showBuildErrorInReferenceDocviews(
  editor: Editor,
  projectName: string,
  error: Pick<BuildError, 'file' | 'line' | 'message'>,
): Promise<boolean> {
  if (!error.file || error.line == null) return false
  const entry = lookupSourceLine(await loadLookup(projectName), error.file, error.line)
  const reference = buildErrorReferenceFromPosition(error, entry, {
    viewboxOffset: SYNCTEX_VIEWBOX_OFFSET,
    pageHeight: PDF_HEIGHT,
  }) as DocviewReference | null
  if (!reference) return false
  return updateReferenceDocviews(editor, reference) > 0
}
