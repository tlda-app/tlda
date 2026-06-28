export function isFleetSourceEditorAllowedDoc(docName?: string | null): boolean {
  const name = docName ?? (
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('doc')
      : ''
  )
  return !!name && (name.startsWith('source-editor-') || name === 'least-squares')
}
