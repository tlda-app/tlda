/**
 * Source Map — unified bidirectional mapping between source and rendered positions.
 *
 * Loads labels.json (all labels with page + type + number) at document init.
 * Provides forward (source → page) and reverse (label → page) lookups.
 *
 * Replaces the scattered partial indices (anchorIndex SVG views, theorem-map,
 * lookup.json line lookups) with one API.
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

let _labels: Label[] = []
let _labelsByName = new Map<string, Label>()
let _labelsByNumber = new Map<string, Label>()
let _loaded = false
let _loading: Promise<void> | null = null

/**
 * Load the label index for a document. Call once at document init.
 */
export function load(docName: string): Promise<void> {
  if (_loaded) return Promise.resolve()
  if (_loading) return _loading
  _loading = fetch(`/docs/${docName}/labels.json`)
    .then(r => r.ok ? r.json() : [])
    .then((labels: Label[]) => {
      _labels = labels
      _labelsByName.clear()
      _labelsByNumber.clear()
      for (const l of labels) {
        _labelsByName.set(l.label, l)
        if (l.number) _labelsByNumber.set(l.number, l)
      }
      _loaded = true
      console.log(`[sourceMap] Loaded ${labels.length} labels`)
    })
    .catch(e => {
      console.warn(`[sourceMap] Failed to load labels: ${e.message}`)
    })
  return _loading
}

/**
 * Resolve a label to its page and metadata.
 * Accepts label name ("cor:scalar-duality") or display number ("B.2").
 */
export function resolveLabel(query: string): Label | null {
  return _labelsByName.get(query) || _labelsByNumber.get(query) || null
}

/**
 * Get all labels.
 */
export function allLabels(): Label[] {
  return _labels
}

/**
 * Find labels on a specific page.
 */
export function labelsOnPage(page: number): Label[] {
  return _labels.filter(l => l.page === page)
}

/**
 * Search labels by partial match (for autocomplete).
 */
export function searchLabels(query: string): Label[] {
  const q = query.toLowerCase()
  return _labels.filter(l =>
    l.label.toLowerCase().includes(q) ||
    l.number.toLowerCase().includes(q) ||
    l.title.toLowerCase().includes(q)
  )
}

/**
 * Clear cached data (call on rebuild).
 */
export function clear() {
  _labels = []
  _labelsByName.clear()
  _labelsByNumber.clear()
  _loaded = false
  _loading = null
}
