/**
 * docLinks.ts — Detect document references in chat messages and make them clickable.
 *
 * Patterns detected:
 *   - "page N" / "p. N" / "p N"
 *   - "line N" / "line N-M"
 *   - "Theorem N.N" / "Lemma N.N" / "Proposition N.N" / "Corollary N.N" / "Definition N.N"
 *   - "Section N" / "§N" / "Appendix X"
 *   - "Equation (N)" / "Eq. (N)" / "eq. N"
 *
 * Each detected reference is wrapped in a <span class="doc-link" data-ref-type="..." data-ref-value="...">
 * The click handler resolves references to canvas coordinates and navigates.
 */

import type { LookupData } from './synctexLookup'
import {
  THEOREM_REF_TYPES,
  REF_NUMBER_SRC,
  normalizeRefNumber,
  refTypeForName,
  labelTypesForEnvType,
} from '../shared/doc-refs.mjs'

// --- Reference pattern matching ---

export interface DocRef {
  type: 'page' | 'line' | 'theorem' | 'section' | 'equation' | 'label'  // label = exact LaTeX label match
  /** The matched text */
  text: string
  /** For page: page number. For line: line number. For theorem/section: display number string. */
  value: string
  /** For theorem-like: the environment type */
  envType?: string
}

// Theorem-like env words (lemma, theorem, prop, …), shared with the server so
// detection can't drift between Skip's chat view and the agent's. The number
// sub-pattern (REF_NUMBER_SRC) accepts letter-prefixed appendix numbers —
// "Lemma C5", "Lemma C.10" — which the old digit-only pattern dropped.
const THEOREM_NAMES = THEOREM_REF_TYPES.flatMap((t: { names: string[] }) => t.names)
const THEOREM_RE = new RegExp(
  '\\b(' + THEOREM_NAMES.join('|') + ')\\s+(' + REF_NUMBER_SRC + ')',
  'gi',
)

// Order matters: longer patterns first to avoid partial matches
const REF_PATTERNS: Array<{ re: RegExp; type: DocRef['type']; envType?: string; multi?: boolean }> = [
  // Theorem-like with number — env word in group 1, number in group 2.
  // envType is derived per-match from the env word (see findRefs).
  { re: THEOREM_RE, type: 'theorem' },

  // Sections — number may be digits ("4", "4.1") or appendix-lettered
  // ("A", "C", "A.1", "E.2", "E2"). The appendix-letter form is genuinely
  // uppercase (NO /i flag) and must not be the first letter of a longer word
  // ((?![A-Za-z])): under a case-insensitive flag, `[A-Z]` with zero trailing
  // digits matched the lowercase initial of the *next* word, so "Section ref"
  // and "Section numbers" lit up. Word stays case-flexible via [Ss]/[Aa].
  { re: /\b([Ss]ection)\s+(\d+(?:\.\d+)*|[A-Z](?:\.?\d+)*(?![A-Za-z]))/g, type: 'section' },
  { re: /§\s*(\d+(?:\.\d+)*)/g, type: 'section' },
  { re: /\b([Aa]ppendix)\s+([A-Z](?:\.?\d+)*(?![A-Za-z]))/g, type: 'section' },

  // Equations
  { re: /\b(?:Equation|Eq\.)\s*\((\d+(?:\.\d+)*)\)/gi, type: 'equation' },
  { re: /\beq\.\s*(\d+(?:\.\d+)*)/gi, type: 'equation' },

  // Page references — "page 36", "p. 36", and the no-dot shorthand "p36"
  // (bare "p" only when a digit follows immediately, to avoid matching "p < 3").
  { re: /\b(?:page\s*|p\.\s*|p(?=\d))(\d+)/gi, type: 'page' },

  // Line lists — "lines 3733 and 3758", "lines 3733, 3758, 3911". Each number
  // becomes its own link (multi). Must come before the single-line pattern.
  { re: /\blines\s+\d+(?:\s*(?:,|and)\s*\d+)+/gi, type: 'line', multi: true },

  // Line references — "line 45", "lines 45-78", approx "line ~3733".
  // (No bare "L45" shorthand: it false-positives on L1/L2 norm notation.)
  { re: /\blines?\s+~?\s*(\d+)(?:\s*[-–]\s*(\d+))?/gi, type: 'line' },

]

/**
 * Find all document references in a plain text string.
 */
export function findRefs(text: string): Array<DocRef & { start: number; end: number }> {
  const refs: Array<DocRef & { start: number; end: number }> = []
  const covered = new Set<number>() // prevent overlapping matches

  for (const pat of REF_PATTERNS) {
    pat.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pat.re.exec(text)) !== null) {
      const start = m.index
      const end = start + m[0].length

      // Skip if overlapping with a previous match
      let overlap = false
      for (let i = start; i < end; i++) {
        if (covered.has(i)) { overlap = true; break }
      }
      if (overlap) continue

      for (let i = start; i < end; i++) covered.add(i)

      // Line lists ("lines 3733 and 3758"): emit one ref per number so each
      // links independently.
      if (pat.multi) {
        const numRe = /\d+/g
        let nm: RegExpExecArray | null
        while ((nm = numRe.exec(m[0])) !== null) {
          refs.push({
            type: 'line',
            text: nm[0],
            value: nm[0],
            start: start + nm.index,
            end: start + nm.index + nm[0].length,
          })
        }
        continue
      }

      let value: string
      let envType = pat.envType
      if (pat.type === 'section' && m[0].startsWith('§')) {
        value = m[1]
      } else if (pat.type === 'theorem') {
        // env word in group 1, number in group 2; normalize "C5" → "C.5"
        value = normalizeRefNumber(m[2])
        envType = refTypeForName(m[1])?.envType
      } else if (pat.type === 'section') {
        // normalize appendix-lettered numbers ("E2" → "E.2")
        value = normalizeRefNumber(m[2])
      } else if (pat.type === 'equation') {
        value = m[1]
      } else if (pat.type === 'page') {
        value = m[1]
      } else {
        // line
        value = m[2] ? `${m[1]}-${m[2]}` : m[1]
      }

      refs.push({
        type: pat.type,
        text: m[0],
        value,
        envType,
        start,
        end,
      })
    }
  }

  refs.sort((a, b) => a.start - b.start)
  return refs
}

/**
 * Post-process rendered HTML to wrap document references as clickable links.
 * Works on the HTML output from chat-render — scans text nodes only (not inside tags).
 */
export function linkifyDocRefs(html: string): string {
  // We process text outside of HTML tags. Split into tag / text segments.
  const TAG_RE = /<[^>]+>/g
  const parts: Array<{ text: string; isTag: boolean }> = []
  let lastIdx = 0
  let tagMatch: RegExpExecArray | null

  TAG_RE.lastIndex = 0
  while ((tagMatch = TAG_RE.exec(html)) !== null) {
    if (tagMatch.index > lastIdx) {
      parts.push({ text: html.slice(lastIdx, tagMatch.index), isTag: false })
    }
    parts.push({ text: tagMatch[0], isTag: true })
    lastIdx = TAG_RE.lastIndex
  }
  if (lastIdx < html.length) {
    parts.push({ text: html.slice(lastIdx), isTag: false })
  }

  // Track nesting to skip inside <a>, <code>, <pre>, doc-link spans, and ref-chip spans
  let skipDepth = 0
  const SKIP_OPEN = /^<(a|code|pre)[\s>]/i
  const SKIP_CLOSE = /^<\/(a|code|pre|span)>/i
  const SPAN_SKIP_OPEN = /^<span\s[^>]*class="[^"]*(?:doc-link|ref-chip)/i
  const SPAN_OPEN = /^<span[\s>]/i

  const result: string[] = []
  for (const part of parts) {
    if (part.isTag) {
      if (skipDepth > 0) {
        // Inside a skip region: track all span nesting to exit correctly
        if (SPAN_OPEN.test(part.text)) skipDepth++
        else if (SKIP_CLOSE.test(part.text)) skipDepth--
      } else {
        if (SKIP_OPEN.test(part.text) || SPAN_SKIP_OPEN.test(part.text)) skipDepth++
        else if (SKIP_CLOSE.test(part.text)) skipDepth = Math.max(0, skipDepth - 1)
      }
      result.push(part.text)
      continue
    }

    if (skipDepth > 0) {
      result.push(part.text)
      continue
    }

    // Find refs in this text segment
    const refs = findRefs(part.text)
    if (refs.length === 0) {
      result.push(part.text)
      continue
    }

    let cursor = 0
    for (const ref of refs) {
      if (ref.start > cursor) {
        result.push(part.text.slice(cursor, ref.start))
      }
      const attrs = [
        `class="doc-link"`,
        `data-ref-type="${ref.type}"`,
        `data-ref-value="${escAttr(ref.value)}"`,
      ]
      if (ref.envType) attrs.push(`data-env-type="${ref.envType}"`)
      result.push(`<span ${attrs.join(' ')}>${part.text.slice(ref.start, ref.end)}</span>`)
      cursor = ref.end
    }
    if (cursor < part.text.length) {
      result.push(part.text.slice(cursor))
    }
  }

  return result.join('')
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

// --- Arrow ref links: [->label] and [->Display Name] ---

export interface LabelRegionInfo {
  page: number
  yTop: number
  yBottom: number
  type: string
  displayLabel: string
}

/**
 * Post-process rendered HTML to convert [->ref] syntax into clickable doc links.
 * Supports both LaTeX labels ([->eq:riesz-rep]) and display names ([->Theorem 3.2]).
 *
 * In the HTML, the `>` in `->` may be escaped as `&gt;` by markdown-it.
 */
export function linkifyArrowRefs(
  html: string,
  labelRegions: Record<string, LabelRegionInfo>,
): string {
  if (!html.includes('-&gt;') && !html.includes('->')) return html

  // Build reverse index: displayLabel → label (case-insensitive)
  const displayToLabel = new Map<string, string>()
  for (const [label, info] of Object.entries(labelRegions)) {
    if (info.displayLabel && info.displayLabel !== label) {
      displayToLabel.set(info.displayLabel.toLowerCase(), label)
    }
  }

  // Match [->...] where > may be &gt;
  const ARROW_RE = /\[-(?:&gt;|>)([^\]]+)\]/g

  // Process text segments outside HTML tags (same approach as linkifyDocRefs)
  const TAG_RE = /<[^>]+>/g
  const parts: Array<{ text: string; isTag: boolean }> = []
  let lastIdx = 0
  let tagMatch: RegExpExecArray | null

  TAG_RE.lastIndex = 0
  while ((tagMatch = TAG_RE.exec(html)) !== null) {
    if (tagMatch.index > lastIdx) {
      parts.push({ text: html.slice(lastIdx, tagMatch.index), isTag: false })
    }
    parts.push({ text: tagMatch[0], isTag: true })
    lastIdx = TAG_RE.lastIndex
  }
  if (lastIdx < html.length) {
    parts.push({ text: html.slice(lastIdx), isTag: false })
  }

  let skipDepth = 0
  const SKIP_OPEN = /^<(a|code|pre)[\s>]/i
  const SKIP_CLOSE = /^<\/(a|code|pre)>/i

  const result: string[] = []
  for (const part of parts) {
    if (part.isTag) {
      if (SKIP_OPEN.test(part.text)) skipDepth++
      else if (SKIP_CLOSE.test(part.text)) skipDepth = Math.max(0, skipDepth - 1)
      result.push(part.text)
      continue
    }

    if (skipDepth > 0) {
      result.push(part.text)
      continue
    }

    // Replace arrow refs in text
    ARROW_RE.lastIndex = 0
    let cursor = 0
    let m: RegExpExecArray | null
    let modified = false

    while ((m = ARROW_RE.exec(part.text)) !== null) {
      modified = true
      if (m.index > cursor) {
        result.push(part.text.slice(cursor, m.index))
      }

      const inner = m[1].trim()
      let label: string | null = null
      let info: LabelRegionInfo | null = null
      let displayText: string

      // Try as exact label first
      if (labelRegions[inner]) {
        label = inner
        info = labelRegions[inner]
        displayText = info.displayLabel !== inner ? info.displayLabel : inner
      } else {
        // Try as display name (case-insensitive)
        const matchedLabel = displayToLabel.get(inner.toLowerCase())
        if (matchedLabel && labelRegions[matchedLabel]) {
          label = matchedLabel
          info = labelRegions[matchedLabel]
          displayText = inner // Use the user's original text
        } else {
          // No match — render as plain text
          displayText = inner
        }
      }

      if (info && label) {
        const attrs = [
          `class="doc-link"`,
          `data-ref-type="label"`,
          `data-ref-label="${escAttr(label)}"`,
          `data-ref-page="${info.page}"`,
          `data-ref-y-top="${info.yTop}"`,
          `data-ref-y-bottom="${info.yBottom}"`,
        ]
        result.push(`<span ${attrs.join(' ')}>${escAttr(displayText)}</span>`)
      } else {
        // Unresolved — render as styled but non-clickable
        result.push(`<span class="doc-link doc-link-unresolved">${escAttr(displayText)}</span>`)
      }

      cursor = m.index + m[0].length
    }

    if (modified) {
      if (cursor < part.text.length) {
        result.push(part.text.slice(cursor))
      }
    } else {
      result.push(part.text)
    }
  }

  return result.join('')
}

/**
 * Scan HTML for exact LaTeX label names from the document and wrap them as doc-links.
 * Matches any label key from labelRegions that appears literally in text nodes.
 * Runs after linkifyDocRefs and linkifyArrowRefs — skips text already inside doc-links.
 */
export function linkifyLabelRefs(
  html: string,
  labelRegions: Record<string, LabelRegionInfo>,
): string {
  const labels = Object.keys(labelRegions)
  if (labels.length === 0) return html

  // Sort labels longest-first to avoid partial matches
  labels.sort((a, b) => b.length - a.length)

  // Build a single regex that matches any label as a whole word
  const escaped = labels.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const labelRe = new RegExp(`(?:^|(?<=[\\s(""'']))(?:${escaped.join('|')})(?=$|[\\s).,;:!?""''])`, 'g')

  // Process text outside HTML tags (same tag-splitting approach)
  const TAG_RE = /<[^>]+>/g
  const parts: Array<{ text: string; isTag: boolean }> = []
  let lastIdx = 0
  let tagMatch: RegExpExecArray | null
  TAG_RE.lastIndex = 0
  while ((tagMatch = TAG_RE.exec(html)) !== null) {
    if (tagMatch.index > lastIdx) parts.push({ text: html.slice(lastIdx, tagMatch.index), isTag: false })
    parts.push({ text: tagMatch[0], isTag: true })
    lastIdx = TAG_RE.lastIndex
  }
  if (lastIdx < html.length) parts.push({ text: html.slice(lastIdx), isTag: false })

  // Skip inside <a>, <code>, <pre>, doc-link, ref-chip
  let skipDepth = 0
  const SKIP_OPEN = /^<(a|code|pre)[\s>]/i
  const SKIP_CLOSE = /^<\/(a|code|pre|span)>/i
  const SPAN_SKIP_OPEN = /^<span\s[^>]*class="[^"]*(?:doc-link|ref-chip)/i
  const SPAN_OPEN = /^<span[\s>]/i

  const result: string[] = []
  for (const part of parts) {
    if (part.isTag) {
      if (skipDepth > 0) {
        if (SPAN_OPEN.test(part.text)) skipDepth++
        else if (SKIP_CLOSE.test(part.text)) skipDepth--
      } else {
        if (SKIP_OPEN.test(part.text) || SPAN_SKIP_OPEN.test(part.text)) skipDepth++
        else if (SKIP_CLOSE.test(part.text)) skipDepth = Math.max(0, skipDepth - 1)
      }
      result.push(part.text)
      continue
    }
    if (skipDepth > 0) { result.push(part.text); continue }

    // Replace label matches
    labelRe.lastIndex = 0
    let cursor = 0
    let m: RegExpExecArray | null
    let modified = false
    const segments: string[] = []
    while ((m = labelRe.exec(part.text)) !== null) {
      const label = m[0]
      const info = labelRegions[label]
      if (!info) continue
      modified = true
      if (m.index > cursor) segments.push(part.text.slice(cursor, m.index))
      segments.push(
        `<span class="doc-link" data-ref-type="label" data-ref-label="${escAttr(label)}" data-ref-page="${info.page}" data-ref-y-top="${info.yTop}" data-ref-y-bottom="${info.yBottom}">${escAttr(label)}</span>`
      )
      cursor = m.index + label.length
    }
    if (modified) {
      if (cursor < part.text.length) segments.push(part.text.slice(cursor))
      result.push(segments.join(''))
    } else {
      result.push(part.text)
    }
  }
  return result.join('')
}

/**
 * Post-process rendered HTML to convert @label references into clickable doc links.
 * @thm:bias-decomp → clickable link showing "Theorem 4.3" (from labelRegions displayLabel).
 * Unresolved refs render with a red warning style.
 */
export function linkifyAtRefs(
  html: string,
  labelRegions: Record<string, LabelRegionInfo>,
): string {
  // Quick bail — @ not present
  if (!html.includes('@')) return html

  const AT_RE = /(?<![\\@\w])@([\w:.-]+[\w])/g

  const TAG_RE = /<[^>]+>/g
  const parts: Array<{ text: string; isTag: boolean }> = []
  let lastIdx = 0
  let tagMatch: RegExpExecArray | null
  TAG_RE.lastIndex = 0
  while ((tagMatch = TAG_RE.exec(html)) !== null) {
    if (tagMatch.index > lastIdx) parts.push({ text: html.slice(lastIdx, tagMatch.index), isTag: false })
    parts.push({ text: tagMatch[0], isTag: true })
    lastIdx = TAG_RE.lastIndex
  }
  if (lastIdx < html.length) parts.push({ text: html.slice(lastIdx), isTag: false })

  let skipDepth = 0
  const SKIP_OPEN = /^<(a|code|pre)[\s>]/i
  const SKIP_CLOSE = /^<\/(a|code|pre|span)>/i
  const SPAN_SKIP_OPEN = /^<span\s[^>]*class="[^"]*(?:doc-link|ref-chip)/i
  const SPAN_OPEN = /^<span[\s>]/i

  const TYPE_DISPLAY: Record<string, string> = {
    thm: 'Thm', lem: 'Lem', prop: 'Prop', cor: 'Cor', def: 'Def',
    ass: 'Asm', eq: 'Eq', sec: '§', fig: 'Fig', tab: 'Tab',
  }

  const result: string[] = []
  for (const part of parts) {
    if (part.isTag) {
      if (skipDepth > 0) {
        if (SPAN_OPEN.test(part.text)) skipDepth++
        else if (SKIP_CLOSE.test(part.text)) skipDepth--
      } else {
        if (SKIP_OPEN.test(part.text) || SPAN_SKIP_OPEN.test(part.text)) skipDepth++
        else if (SKIP_CLOSE.test(part.text)) skipDepth = Math.max(0, skipDepth - 1)
      }
      result.push(part.text)
      continue
    }
    if (skipDepth > 0) { result.push(part.text); continue }

    AT_RE.lastIndex = 0
    let cursor = 0
    let m: RegExpExecArray | null
    let modified = false
    const segments: string[] = []

    while ((m = AT_RE.exec(part.text)) !== null) {
      modified = true
      if (m.index > cursor) segments.push(part.text.slice(cursor, m.index))

      const label = m[1]
      const info = labelRegions[label]

      if (info) {
        const typePrefix = label.split(':')[0]
        const typeLabel = TYPE_DISPLAY[typePrefix] || ''
        const displayText = info.displayLabel && info.displayLabel !== label
          ? info.displayLabel
          : (typeLabel ? `${typeLabel} ${label.split(':').slice(1).join(':')}` : label)
        segments.push(
          `<span class="doc-link at-ref" data-ref-type="label" data-ref-label="${escAttr(label)}" data-ref-page="${info.page}" data-ref-y-top="${info.yTop}" data-ref-y-bottom="${info.yBottom}">${escAttr(displayText)}</span>`
        )
      } else {
        segments.push(`<span class="doc-link doc-link-unresolved at-ref-broken">@${escAttr(label)}</span>`)
      }

      cursor = m.index + m[0].length
    }

    if (modified) {
      if (cursor < part.text.length) segments.push(part.text.slice(cursor))
      result.push(segments.join(''))
    } else {
      result.push(part.text)
    }
  }
  return result.join('')
}

/**
 * Post-process rendered HTML to convert raw LaTeX cross-reference commands —
 * \ref{l}, \eqref{l}, \cref{l}/\Cref{l}, \autoref{l}, \cpageref{l} — into the
 * form LaTeX would compile them to, as clickable doc-links:
 *   \ref{lem:envelope}   → "A.5"           (bare number)
 *   \eqref{eq:foo}       → "(14)"          (number in parens)
 *   \cref{lem:envelope}  → "Lemma A.5"     (type + number, type from the table)
 * Resolution data: labelRegions for page/y nav + displayLabel; theoremMap for
 * the authoritative type/number (esp. sections, whose displayLabel is the raw
 * label). Unknown labels are left as the original text.
 */
const _TYPE_WORD: Record<string, string> = {
  lem: 'Lemma', thm: 'Theorem', prop: 'Proposition', cor: 'Corollary',
  def: 'Definition', ass: 'Assumption', rem: 'Remark', eq: 'Equation',
  sec: 'Section', fig: 'Figure', tab: 'Table',
}
const _FULL_TO_KEY: Record<string, string> = {
  equation: 'eq', section: 'sec', theorem: 'thm', lemma: 'lem',
  proposition: 'prop', corollary: 'cor', definition: 'def',
  assumption: 'ass', remark: 'rem', figure: 'fig', table: 'tab',
}

export function linkifyRefCommands(
  html: string,
  labelRegions: Record<string, LabelRegionInfo>,
  theoremMap?: Record<string, TheoremMapEntry>,
): string {
  if (!html.includes('\\')) return html

  const numberFromDisplay = (dl?: string): string => {
    if (!dl) return ''
    const paren = dl.match(/\(([^)]+)\)/)
    if (paren) return paren[1]
    const tail = dl.match(/([A-Z]?\.?\d[\d.]*|[A-Z](?:\.\d+)*)\s*$/)
    return tail ? tail[1] : ''
  }

  const renderOne = (cmd: string, label: string): string | null => {
    const info = labelRegions[label]
    const tm = theoremMap?.[label]
    if (!info && !tm) return null

    const typeKey = (tm?.type || _FULL_TO_KEY[info?.type || ''] || '').toLowerCase()
    const num = (tm?.number || numberFromDisplay(info?.displayLabel)).toString()
    const niceDisplay = info?.displayLabel && info.displayLabel !== label ? info.displayLabel : ''

    let text: string
    if (cmd === 'eqref') text = num ? `(${num})` : (niceDisplay || label)
    else if (cmd === 'ref' || cmd === 'vref') text = num || niceDisplay || label
    else if (cmd === 'cpageref' || cmd === 'Cpageref') text = `page ${info?.page ?? tm?.page ?? '?'}`
    else {
      // cref / Cref / autoref / namecref → "Type Number". Without a resolved
      // number, never emit a bare type word ("Section ", "Eq. ()", "Lemma ") —
      // that renders as a clickable "Section" with no number. Fall back to the
      // nice display or the raw label, exactly like \ref does.
      if (!num) text = niceDisplay || label
      else if (typeKey === 'eq') text = `Eq. (${num})`
      else if (typeKey === 'sec') text = `${/^[A-Z]/.test(num) ? 'Appendix' : 'Section'} ${num}`
      else if (niceDisplay) text = niceDisplay
      else text = `${_TYPE_WORD[typeKey] || ''} ${num}`.trim()
    }
    if (!text) return null

    const page = info?.page ?? tm?.page
    if (page == null) return null
    const attrs = [
      `class="doc-link ref-cmd"`,
      `data-ref-type="label"`,
      `data-ref-label="${escAttr(label)}"`,
      `data-ref-page="${page}"`,
    ]
    if (info?.yTop != null) attrs.push(`data-ref-y-top="${info.yTop}"`)
    if (info?.yBottom != null) attrs.push(`data-ref-y-bottom="${info.yBottom}"`)
    return `<span ${attrs.join(' ')}>${escAttr(text)}</span>`
  }

  const CMD_RE = /\\(eqref|cref|Cref|autoref|namecref|vref|cpageref|Cpageref|ref)\b\*?\s*\{([^}]*)\}/g

  const TAG_RE = /<[^>]+>/g
  const parts: Array<{ text: string; isTag: boolean }> = []
  let lastIdx = 0
  let tagMatch: RegExpExecArray | null
  TAG_RE.lastIndex = 0
  while ((tagMatch = TAG_RE.exec(html)) !== null) {
    if (tagMatch.index > lastIdx) parts.push({ text: html.slice(lastIdx, tagMatch.index), isTag: false })
    parts.push({ text: tagMatch[0], isTag: true })
    lastIdx = TAG_RE.lastIndex
  }
  if (lastIdx < html.length) parts.push({ text: html.slice(lastIdx), isTag: false })

  let skipDepth = 0
  const SKIP_OPEN = /^<(a|code|pre)[\s>]/i
  const SKIP_CLOSE = /^<\/(a|code|pre|span)>/i
  const SPAN_SKIP_OPEN = /^<span\s[^>]*class="[^"]*(?:doc-link|ref-chip)/i
  const SPAN_OPEN = /^<span[\s>]/i

  const result: string[] = []
  for (const part of parts) {
    if (part.isTag) {
      if (skipDepth > 0) {
        if (SPAN_OPEN.test(part.text)) skipDepth++
        else if (SKIP_CLOSE.test(part.text)) skipDepth--
      } else {
        if (SKIP_OPEN.test(part.text) || SPAN_SKIP_OPEN.test(part.text)) skipDepth++
        else if (SKIP_CLOSE.test(part.text)) skipDepth = Math.max(0, skipDepth - 1)
      }
      result.push(part.text)
      continue
    }
    if (skipDepth > 0) { result.push(part.text); continue }

    CMD_RE.lastIndex = 0
    let cursor = 0
    let m: RegExpExecArray | null
    let modified = false
    const segments: string[] = []
    while ((m = CMD_RE.exec(part.text)) !== null) {
      const cmd = m[1]
      // \cref{a,b} — render each label, comma-joined
      const labels = m[2].split(/\s*,\s*/).map(s => s.trim()).filter(Boolean)
      const rendered = labels.map(l => renderOne(cmd, l))
      if (!rendered.length || rendered.some(r => r === null)) continue // leave raw if any unknown
      modified = true
      if (m.index > cursor) segments.push(part.text.slice(cursor, m.index))
      segments.push(rendered.join(', '))
      cursor = m.index + m[0].length
    }
    if (modified) {
      if (cursor < part.text.length) segments.push(part.text.slice(cursor))
      result.push(segments.join(''))
    } else {
      result.push(part.text)
    }
  }
  return result.join('')
}

// --- Reference resolution ---

export interface ResolvedRef {
  page: number     // 1-indexed
  pdfY?: number    // PDF y-coordinate (for sub-page positioning)
}

/**
 * Build a resolver from lookup data. Returns a function that maps DocRef → page/y.
 */
export interface TheoremMapEntry {
  label: string
  type: string
  number: string
  page: number
  title?: string
}

export function buildRefResolver(lookup: LookupData, theoremMap?: Record<string, TheoremMapEntry>): (ref: DocRef) => ResolvedRef | null {
  // Pre-index: sections in document order, theorem-like envs in order
  const sections: Array<{ num: string; page: number; y: number }> = []
  const envs: Record<string, Array<{ page: number; y: number; idx: number }>> = {}

  // Count environments to assign display numbers
  const envCounters: Record<string, number> = {}
  // Track section number for numbered items
  let currentSection = 0

  // Sort entries by page then y for stable ordering
  const sorted = Object.entries(lookup.lines)
    .map(([key, entry]) => ({ key, entry }))
    .sort((a, b) => a.entry.page - b.entry.page || a.entry.y - b.entry.y)

  for (const { entry } of sorted) {
    const c = entry.content

    // Section heading
    const secMatch = c.match(/\\section\*?\{/)
    if (secMatch) {
      currentSection++
      sections.push({ num: String(currentSection), page: entry.page, y: entry.y })
      continue
    }

    // Subsection
    const subMatch = c.match(/\\subsection\*?\{/)
    if (subMatch) {
      // We don't track subsection numbering for now — section refs are enough
      continue
    }

    // Theorem-like environments
    const envMatch = c.match(/\\begin\{(theorem|lemma|proposition|corollary|definition|remark|example|assumption)\}/)
    if (envMatch) {
      const envType = envMatch[1]
      if (!envCounters[envType]) envCounters[envType] = 0
      envCounters[envType]++
      if (!envs[envType]) envs[envType] = []
      envs[envType].push({ page: entry.page, y: entry.y, idx: envCounters[envType] })
    }
  }

  return (ref: DocRef): ResolvedRef | null => {
    switch (ref.type) {
      case 'page': {
        const page = parseInt(ref.value)
        return isNaN(page) ? null : { page }
      }

      case 'line': {
        const lineNum = parseInt(ref.value.split('-')[0])
        if (isNaN(lineNum)) return null
        // Look up in lookup.lines
        const entry = lookup.lines[String(lineNum)]
        if (entry) return { page: entry.page, pdfY: entry.y }
        // Try nearby lines
        for (let off = 1; off <= 10; off++) {
          const nearby = lookup.lines[String(lineNum + off)] || lookup.lines[String(lineNum - off)]
          if (nearby) return { page: nearby.page, pdfY: nearby.y }
        }
        return null
      }

      case 'section': {
        // Prefer the label table: it carries section/appendix numbers verbatim,
        // including letters ("A", "C", "A.1", "E.2"), so we don't have to
        // reconstruct appendix ordering by counting headings.
        if (theoremMap) {
          const num = normalizeRefNumber(ref.value)
          for (const entry of Object.values(theoremMap)) {
            if (entry.type === 'sec' && entry.number === num) {
              return { page: entry.page }
            }
          }
          // Graceful fallback: an appendix sub-section with no label of its own
          // ("Appendix E.2" when only "E" is labeled) → land on the parent appendix.
          const parent = num.match(/^([A-Z])(?=\.|$)/)?.[1]
          if (parent && parent !== num) {
            for (const entry of Object.values(theoremMap)) {
              if (entry.type === 'sec' && entry.number === parent) {
                return { page: entry.page }
              }
            }
          }
        }

        // ref.value is like "2" or "A" (for appendix)
        const letter = ref.value.match(/^[A-Z]/)
        if (letter) {
          // Appendix — use appendixLine to find where appendix starts,
          // then count sections after it. A=1st, B=2nd, etc.
          const appLine = lookup.meta.appendixLine
          if (!appLine) return null
          // Find sections that come after the appendix boundary by page
          // We need to find the page of the appendix line first
          const appEntry = lookup.lines[String(appLine.line)]
          const appPage = appEntry ? appEntry.page : Infinity
          const appSections = sections.filter(s => s.page >= appPage)
          const idx = ref.value.charCodeAt(0) - 65 // A=0, B=1
          if (idx >= 0 && idx < appSections.length) {
            return { page: appSections[idx].page, pdfY: appSections[idx].y }
          }
          return null
        }

        const secNum = parseInt(ref.value)
        if (isNaN(secNum) || secNum < 1 || secNum > sections.length) return null
        const sec = sections[secNum - 1]
        return { page: sec.page, pdfY: sec.y }
      }

      case 'theorem': {
        // First try theorem-map (authoritative: parsed from .aux file).
        // Match the entry's label-type against the shared type list for this
        // envType — a naive slice(0,3) breaks theorem ("the"≠"thm") and
        // proposition ("pro"≠"prop").
        if (theoremMap && ref.envType) {
          const validTypes: string[] = labelTypesForEnvType(ref.envType)
          for (const entry of Object.values(theoremMap)) {
            if (entry.number === ref.value && validTypes.includes(entry.type)) {
              return { page: entry.page }
            }
          }
        }

        if (!ref.envType) return null
        const envList = envs[ref.envType]
        if (!envList) return null

        // ref.value might be "3.1" (section.local) or just "1" (global counter)
        const parts = ref.value.split('.')
        if (parts.length === 1) {
          const idx = parseInt(parts[0])
          if (!isNaN(idx) && idx >= 1 && idx <= envList.length) {
            const e = envList[idx - 1]
            return { page: e.page, pdfY: e.y }
          }
        } else {
          const globalIdx = envList.findIndex(e => e.idx === parseInt(parts[parts.length - 1]))
          if (globalIdx >= 0) {
            return { page: envList[globalIdx].page, pdfY: envList[globalIdx].y }
          }
          const lastNum = parseInt(parts[parts.length - 1])
          if (!isNaN(lastNum) && lastNum >= 1 && lastNum <= envList.length) {
            return { page: envList[lastNum - 1].page, pdfY: envList[lastNum - 1].y }
          }
        }
        return null
      }

      case 'equation':
        // Can't easily resolve equation numbers from lookup data
        return null

      default:
        return null
    }
  }
}

/**
 * Convert a resolved reference to canvas coordinates.
 */
export function refToCanvas(
  resolved: ResolvedRef,
  pages: Array<{ bounds: { x: number; y: number; width: number; height: number } }>,
  pdfHeight: number,
): { x: number; y: number } | null {
  const pageIdx = resolved.page - 1
  if (pageIdx < 0 || pageIdx >= pages.length) return null
  const bounds = pages[pageIdx].bounds

  const cx = bounds.x + bounds.width / 2
  let cy: number
  if (resolved.pdfY != null) {
    // Scale PDF y to canvas y
    const scale = bounds.height / pdfHeight
    cy = bounds.y + resolved.pdfY * scale
  } else {
    // Center on page top third
    cy = bounds.y + bounds.height * 0.3
  }

  return { x: cx, y: cy }
}
