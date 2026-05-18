/**
 * Source Map — unified bidirectional mapping between source and rendered positions.
 *
 * Loads one file: source-map.json (generated at build time from synctex + aux).
 * Contains:
 *   - labels: all \label{} items with page, type, number
 *   - pages: per-page sorted line index (y → file:line) for forward/reverse lookup
 *
 * One file, one module, one API. Replaces lookup.json, theorem-map.json, labels.json,
 * anchorIndex, and buildReverseIndex.
 */

export interface Label {
  label: string       // "cor:scalar-duality"
  type: string        // "cor"
  number: string      // "B.2"
  page: number        // 1-indexed PDF page
  title: string       // "Scalar specialization"
  file?: string       // "bregman-lower-bound.tex"
  line?: number       // source line
}

interface PageEntry {
  y: number           // PDF y position
  file: string        // relative source file
  line: number        // source line number
}

let _labels: Label[] = []
let _labelsByName = new Map<string, Label>()
let _labelsByNumber = new Map<string, Label>()
let _pages: Record<string, PageEntry[]> = {}  // page number → sorted entries
let _docName = ''
let _loaded = false
let _loading: Promise<void> | null = null

/**
 * Load source maps for a document. For multi-target docs, fetches per-target
 * source-maps and merges them with global page offsets. For single-target docs,
 * fetches the bare source-map.json alias (which resolves to the primary target).
 */
export function load(docName: string, targets?: Array<{ name: string; pages: number }>): Promise<void> {
  if (_loaded && _docName === docName) return Promise.resolve()
  if (_loading) return _loading
  _docName = docName
  _loading = (async () => {
    try {
      if (targets && targets.length > 1) {
        // Multi-target: load each target's source-map and merge with page offsets
        const allLabels: Label[] = []
        const allPages: Record<string, PageEntry[]> = {}
        let pageOffset = 0
        for (const target of targets) {
          try {
            const r = await fetch(`/docs/${docName}/${target.name}-source-map.json`)
            if (!r.ok) { pageOffset += target.pages; continue }
            const data = await r.json()
            for (const l of (data.labels || []) as Label[]) {
              allLabels.push({ ...l, page: l.page + pageOffset })
            }
            for (const [pageStr, entries] of Object.entries(data.pages || {})) {
              const globalPage = parseInt(pageStr) + pageOffset
              allPages[String(globalPage)] = entries as PageEntry[]
            }
          } catch { /* skip failed target */ }
          pageOffset += target.pages
        }
        _labels = allLabels
        _pages = allPages
      } else {
        // Single-target or fallback: bare alias resolves to primary target's file
        const r = await fetch(`/docs/${docName}/source-map.json`)
        if (!r.ok) throw new Error(`${r.status}`)
        const data = await r.json()
        _labels = data.labels || []
        _pages = data.pages || {}
      }
      _labelsByName.clear()
      _labelsByNumber.clear()
      for (const l of _labels) {
        _labelsByName.set(l.label, l)
        if (l.number) _labelsByNumber.set(l.number, l)
      }
      _loaded = true
      console.log(`[sourceMap] Loaded: ${_labels.length} labels, ${Object.keys(_pages).length} pages`)
    } catch (e: any) {
      console.warn(`[sourceMap] Failed to load: ${e.message}`)
    }
  })()
  return _loading
}

// --- Label lookups ---

/**
 * Resolve a label to its page and metadata.
 * Accepts label name ("cor:scalar-duality") or display number ("B.2").
 */
export function resolveLabel(query: string): Label | null {
  return _labelsByName.get(query) || _labelsByNumber.get(query) || null
}

/** Get all labels. */
export function allLabels(): Label[] { return _labels }

/** Find labels on a specific page. */
export function labelsOnPage(page: number): Label[] {
  return _labels.filter(l => l.page === page)
}

/** Search labels by partial match. */
export function searchLabels(query: string): Label[] {
  const q = query.toLowerCase()
  return _labels.filter(l =>
    l.label.toLowerCase().includes(q) ||
    l.number.toLowerCase().includes(q) ||
    l.title.toLowerCase().includes(q)
  )
}

// --- Forward lookup: source → page ---

/**
 * Forward lookup: source file:line → rendered page + y position.
 */
export function sourceToPage(file: string, line: number): { page: number; y: number } | null {
  for (const [page, entries] of Object.entries(_pages)) {
    for (const e of entries) {
      if (e.line === line && (e.file === file || file === '' || e.file.endsWith(file))) {
        return { page: parseInt(page), y: e.y }
      }
    }
  }
  return null
}

// --- Reverse lookup: page → source ---

/**
 * Reverse lookup: page + y position → nearest source file:line.
 */
export function pageToSource(page: number, y: number): { file: string; line: number } | null {
  const entries = _pages[String(page)]
  if (!entries || entries.length === 0) return null
  // Binary search for nearest y
  let lo = 0, hi = entries.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (entries[mid].y < y) lo = mid + 1
    else hi = mid
  }
  // Check lo and lo-1 for closest
  let best = entries[lo]
  if (lo > 0 && Math.abs(entries[lo - 1].y - y) < Math.abs(best.y - y)) {
    best = entries[lo - 1]
  }
  return { file: best.file, line: best.line }
}

// --- Lifecycle ---

/** Clear cached data (call on rebuild). */
export function clear() {
  _labels = []
  _labelsByName.clear()
  _labelsByNumber.clear()
  _pages = {}
  _loaded = false
  _loading = null
  _docName = ''
}
