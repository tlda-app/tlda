import { HTML_PAGE_FORMATS } from '../shared/document-formats.mjs'

export function fetchDocumentSvgPages<TEditor, TDocument extends { format?: string }>(
  editor: TEditor,
  document: TDocument,
  fetchSvgPages: (editor: TEditor, document: TDocument) => unknown,
): boolean {
  if (HTML_PAGE_FORMATS.has(document.format || '') || ['png', 'slides'].includes(document.format || '')) {
    return false
  }
  void fetchSvgPages(editor, document)
  return true
}
