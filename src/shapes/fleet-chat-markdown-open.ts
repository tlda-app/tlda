type MarkdownColumnOptions = {
  title: string
  markdown: string
  sourcePath?: string
  sourceSection?: string
  logPrefix: string
}

type ChipSource = {
  path?: string
  section?: string
}

type OpenMarkdownChipOptions = {
  target: HTMLElement
  stopPropagation: () => void
  openMarkdownColumn: (title: string, markdown: string, sourceEl: HTMLElement, source?: ChipSource) => void
}

export async function fetchMarkdownChipText(chipUrl: string, chipPath: string): Promise<string> {
  const candidates = [
    chipUrl,
    chipPath ? `/api/read-file?path=${encodeURIComponent(chipPath)}` : '',
  ].filter(Boolean)
  let lastError: unknown = null
  for (const url of candidates) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.text()
      lastError = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('markdown chip fetch failed')
}

export type MaterializeChipResult = {
  ok: boolean
  outputFile?: string
  error?: string
}

// Turns a shared/embedded markdown chip into a real, synced column of the
// document currently open on canvas — not a separate project, not a
// throwaway snapshot. The target project is whatever `?doc=` is loaded;
// the server writes the file as a project part and rebuilds, and the
// existing reload/signal pipeline picks up the new column for everyone
// looking at that doc (the same mechanism that already keeps project
// parts/notes live).
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
  const docName = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('doc')
  if (!docName) return { ok: false, error: 'no open document to attach to' }
  try {
    const res = await fetch(`/api/projects/${docName}/parts`, {
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

export function openChatMarkdownColumn(options: MarkdownColumnOptions) {
  const { title, markdown, sourcePath, sourceSection, logPrefix } = options
  void materializeMarkdownChip({ markdown, title, sourcePath, sourceSection }).then((result) => {
    if (!result.ok) {
      console.warn(`[${logPrefix}] markdown materialize failed:`, result.error)
    }
  })
}

export function openMarkdownChipFromTarget(options: OpenMarkdownChipOptions): boolean {
  const { target, stopPropagation, openMarkdownColumn } = options
  const mdChip = target.closest('.ref-chip-doc, .md-file-card') as HTMLElement | null
  if (!mdChip) return false

  const chipUrl = mdChip.dataset.url || ''
  const chipPath = mdChip.dataset.path || ''
  const chipSection = mdChip.dataset.section || undefined

  if (mdChip.classList.contains('src-chip')) {
    stopPropagation()
    const title = mdChip.getAttribute('title') || mdChip.textContent || 'source'
    // Provenance chips are a shared-file chip plus a section focus, not a
    // section-only snapshot — fetch the whole raw source file (same path as
    // a plain file chip), never the rendered chat bubble text.
    fetchMarkdownChipText(chipUrl, chipPath)
      .then(text => openMarkdownColumn(title, text, mdChip, { path: chipPath, section: chipSection }))
      .catch(() => openMarkdownColumn(title, `# Failed to load\n\n${chipPath || title}`, mdChip, { path: chipPath, section: chipSection }))
    return true
  }

  const isMd = /\.md$/i.test(chipUrl || chipPath)
  const fetchUrl = chipUrl || (chipPath ? `/api/read-file?path=${encodeURIComponent(chipPath)}` : '')
  if (!isMd || !fetchUrl) return false

  stopPropagation()
  const title = mdChip.querySelector('.md-file-chip')?.textContent || mdChip.textContent || chipPath.split('/').pop() || 'file'
  fetchMarkdownChipText(chipUrl, chipPath)
    .then(text => {
      const baseUrl = chipUrl ? chipUrl.substring(0, chipUrl.lastIndexOf('/') + 1) : ''
      const resolved = baseUrl ? text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
        if (src.startsWith('http') || src.startsWith('/')) return match
        return `![${alt}](${baseUrl}${src})`
      }) : text
      openMarkdownColumn(title, resolved, mdChip, { path: chipPath })
    })
    .catch(() => {
      openMarkdownColumn(title, `# Failed to load\n\n${chipUrl || chipPath || title}`, mdChip, { path: chipPath })
    })
  return true
}
