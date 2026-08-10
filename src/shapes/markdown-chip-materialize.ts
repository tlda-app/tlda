export type MaterializeChipResult = {
  ok: boolean
  outputFile?: string
  error?: string
}

// Writes a markdown chip as a real, synced column (project part) of the
// document currently open on canvas.
export async function materializeMarkdownChip({
  markdown,
  title,
  sourcePath,
  sourceSection,
}: {
  markdown: string
  title: string
  sourcePath?: string
  sourceSection?: string
}): Promise<MaterializeChipResult> {
  const projectName = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('project')
  if (!projectName) return { ok: false, error: 'no open document to attach to' }
  try {
    const res = await fetch(`/api/projects/${projectName}/parts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown,
        title,
        sourcePath,
        provenance: sourceSection ? { section: sourceSection } : undefined,
      }),
    })
    const result = await res.json().catch(() => null)
    if (!res.ok || !result?.ok) {
      return { ok: false, error: result?.error || `materialize failed: HTTP ${res.status}` }
    }
    return { ok: true, outputFile: result.outputFile }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
