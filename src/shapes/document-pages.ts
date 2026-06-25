export function isDocumentPageShape(s: any): boolean {
  const type = s?.type as string
  if (type !== 'svg-page' && type !== 'html-page') return false
  return !s?.meta?.temporaryMarkdownColumn
}
