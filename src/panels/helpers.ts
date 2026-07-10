import type { Editor, TLPageId, TLShape, TLShapeId } from 'tldraw'
import katex from 'katex'
import { getActiveMacros } from '../katexMacros'
import type { LookupEntry } from '../synctexLookup'
import type { DocContextValue } from '../PanelContext'
import { getHtmlHeadingY } from '../shapes/HtmlPageShape'

// --- Helpers ---

type HtmlPageNavShape = {
  id: string
  type: 'html-page'
  parentId: TLPageId
  x: number
  y: number
  props: { w: number; h: number }
}

function htmlPageNavShape(shape: unknown): HtmlPageNavShape | undefined {
  const candidate = shape as Partial<HtmlPageNavShape> & { type?: unknown; props?: Partial<HtmlPageNavShape['props']> }
  if (candidate?.type !== 'html-page') return undefined
  if (typeof candidate.id !== 'string') return undefined
  if (typeof candidate.parentId !== 'string') return undefined
  if (typeof candidate.x !== 'number' || typeof candidate.y !== 'number') return undefined
  if (typeof candidate.props?.w !== 'number' || typeof candidate.props?.h !== 'number') return undefined
  return candidate as HtmlPageNavShape
}

function currentHtmlPageShape(editor: Editor): HtmlPageNavShape | undefined {
  for (const shape of editor.getCurrentPageShapes()) {
    const htmlShape = htmlPageNavShape(shape)
    if (htmlShape) return htmlShape
  }
  return undefined
}

export function formatRelativeTime(ts: number | undefined): string {
  if (!ts) return ''
  const delta = Date.now() - ts
  if (delta < 60_000) return 'just now'
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86400_000) return `${Math.floor(delta / 3600_000)}h ago`
  return `${Math.floor(delta / 86400_000)}d ago`
}

export function navigateTo(editor: Editor, canvasX: number, canvasY: number, pageCenterX?: number) {
  const x = pageCenterX ?? canvasX
  editor.centerOnPoint({ x, y: canvasY }, { animation: { duration: 300 } })
}

export function navigateToPage(editor: Editor, doc: Pick<DocContextValue, 'pages'>, pageNum: number) {
  const pageIndex = pageNum - 1
  if (pageIndex < 0 || pageIndex >= doc.pages.length) return
  const page = doc.pages[pageIndex]
  const pageShape = page.shapeId ? htmlPageNavShape(editor.getShape(page.shapeId as TLShapeId)) : undefined
  const tlPageId = pageShape?.parentId || (page.tldrawPageId as TLPageId | undefined)

  if (tlPageId) {
    // Multipage HTML: switch TLDraw page and center on the shape
    editor.setCurrentPage(tlPageId)
    const shape = pageShape || currentHtmlPageShape(editor)
    if (shape) {
      const vpH = editor.getViewportPageBounds().h
      editor.centerOnPoint(
        { x: shape.x + shape.props.w / 2, y: shape.y + vpH * 0.3 },
        { animation: { duration: 300 } },
      )
    }
  } else {
    // SVG/slides: center the slide in the viewport
    navigateTo(editor, page.bounds.x + page.bounds.width / 2, page.bounds.y + page.bounds.height / 2)
  }
}

export function navigateToAnchor(editor: Editor, doc: Pick<DocContextValue, 'pages'>, pageNum: number, anchor: string) {
  const pageIndex = pageNum - 1
  if (pageIndex < 0 || pageIndex >= doc.pages.length) return
  const page = doc.pages[pageIndex]
  const pageShape = page.shapeId ? htmlPageNavShape(editor.getShape(page.shapeId as TLShapeId)) : undefined
  const tlPageId = pageShape?.parentId || (page.tldrawPageId as TLPageId | undefined)

  if (!tlPageId) {
    return navigateToPage(editor, doc, pageNum)
  }

  // Switch to the target TLDraw page
  editor.setCurrentPage(tlPageId)
  const shape = pageShape || currentHtmlPageShape(editor)
  if (!shape) return

  const cx = shape.x + shape.props.w / 2

  // Check if anchor position is already known
  const yOff = getHtmlHeadingY(shape.id, anchor)
  if (yOff != null) {
    editor.centerOnPoint({ x: cx, y: shape.y + yOff }, { animation: { duration: 300 } })
    return
  }

  // Anchor not yet resolved — center on page top, poll for the anchor
  const vpH = editor.getViewportPageBounds().h
  editor.centerOnPoint({ x: cx, y: shape.y + vpH * 0.3 }, { animation: { duration: 300 } })

  const targetId = shape.id
  const poll = setInterval(() => {
    const y = getHtmlHeadingY(targetId, anchor)
    if (y != null) {
      clearInterval(poll)
      const fresh = htmlPageNavShape(editor.getShape(targetId as TLShapeId))
      if (fresh) {
        editor.centerOnPoint(
          { x: fresh.x + fresh.props.w / 2, y: fresh.y + y },
          { animation: { duration: 300 } },
        )
      }
    }
  }, 200)
  setTimeout(() => clearInterval(poll), 8000)
}

// --- Heading parsing ---

export type TocLevel = 'part' | 'chapter' | 'section' | 'subsection' | 'subsubsection' | 'divider'

export interface TocEntry {
  level: TocLevel
  title: string
  line: number
  entry: LookupEntry
}


export function parseHeadings(lines: Record<string, LookupEntry>, meta?: { appendixLine?: { line: number; file?: string } }, opts?: { skipAppendixDivider?: boolean }): TocEntry[] {
  const headings: TocEntry[] = []
  const sectionRe = /\\((?:sub)+)?section\*?\{([^}]*)\}/

  // Find appendix boundary — use metadata from synctex extraction (scans source files)
  // The \appendix and \begin{appendix} commands produce no typeset output, so they
  // never appear in synctex. The extractor scans source files and records the line.
  let appendixEntry: LookupEntry | null = null
  if (meta?.appendixLine) {
    const al = meta.appendixLine
    // Search for the first section heading after the appendix command.
    // First try same-file entries after the \appendix line number.
    // If that only finds non-section content (e.g. \end{document}), fall back
    // to the earliest input-file entry by page — the \input{appendix-...}
    // typically follows \appendix immediately.
    let bestKey: string | null = null
    let bestLine = Infinity
    let bestInputKey: string | null = null
    let bestInputPage = Infinity
    for (const [lineStr, entry] of Object.entries(lines)) {
      let lineNum: number
      let file: string | undefined
      const colonIdx = lineStr.lastIndexOf(':')
      if (colonIdx > 0 && lineStr.slice(0, colonIdx).includes('.')) {
        file = lineStr.slice(0, colonIdx)
        lineNum = parseInt(lineStr.slice(colonIdx + 1))
      } else {
        lineNum = parseInt(lineStr)
      }
      if (isNaN(lineNum)) continue
      const sameFile = al.file ? file === al.file : !file
      if (sameFile && lineNum > al.line && lineNum < bestLine) {
        bestLine = lineNum
        bestKey = lineStr
      }
      // Also track earliest input-file entry (for cross-file appendix)
      if (file && entry.page < bestInputPage) {
        bestInputPage = entry.page
        bestInputKey = lineStr
      }
    }
    // Use same-file match if it's a section heading; otherwise use input file
    if (bestKey && sectionRe.test(lines[bestKey].content)) {
      appendixEntry = lines[bestKey]
    } else if (bestInputKey) {
      appendixEntry = lines[bestInputKey]
    } else if (bestKey) {
      appendixEntry = lines[bestKey]
    }
  }

  for (const [, entry] of Object.entries(lines)) {
    // Sort key: always use page position for consistent ordering across
    // plain line numbers and multi-file keys ("file.tex:N")
    const lineNum = entry.page * 10000 + Math.round(entry.y)

    const m = entry.content.match(sectionRe)
    if (!m) continue
    const subDepth = m[1] ? m[1].length / 3 : 0
    let level: TocLevel = subDepth >= 2 ? 'subsubsection' : subDepth === 1 ? 'subsection' : 'section'
    // No demotion — appendix \sections stay at section level
    // Clean title: preserve $...$ math, strip other TeX
    let title = m[2]
      .replace(/~}/g, '}')                         // trailing ~ before }
      .replace(/\\ref\{[^}]*\}/g, '')              // drop \ref{...}
      .replace(/~\\ref\{[^}]*\}/g, '')             // drop ~\ref{...}
      .replace(/\s+/g, ' ')
      .trim()
    if (!title) title = '(untitled)'
    headings.push({ level, title, line: lineNum, entry })
  }

  headings.sort((a, b) => a.line - b.line)

  // Insert a divider before appendix sections (visual separator, not a parent)
  // Skip when multi-target — the supplement target already gets its own divider
  if (appendixEntry && !opts?.skipAppendixDivider) {
    const insertIdx = headings.findIndex(h => h.entry.page >= appendixEntry!.page)
    if (insertIdx >= 0) {
      headings.splice(insertIdx, 0, {
        level: 'divider',
        title: 'Appendix',
        line: headings[insertIdx].line - 1,
        entry: appendixEntry,
      })
    }
  }

  return headings
}

// --- Render TOC title: inline KaTeX for $...$ ---

export function renderTocTitle(title: string): string {
  const macros = getActiveMacros()
  // Split on $...$ preserving delimiters
  return title.replace(/\$([^$]+)\$/g, (_, tex) => {
    try {
      return katex.renderToString(tex.trim(), { macros, throwOnError: false, displayMode: false })
    } catch {
      return tex
    }
  })
    // Strip non-math TeX commands from the text portions
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}~]/g, '')
}

// --- Strip TeX noise for display ---

export function stripTex(s: string): string {
  return s
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}$~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// --- Get text from a shape ---

export function getShapeText(shape: TLShape): string {
  const props = shape.props as Record<string, unknown>
  // math-note uses .text
  if (typeof props.text === 'string') return props.text
  // tldraw note uses .richText
  if (props.richText && typeof props.richText === 'object') {
    return extractRichText(props.richText as RichTextDoc)
  }
  return ''
}

interface RichTextDoc {
  content?: Array<{ content?: Array<{ text?: string }> }>
}

function extractRichText(doc: RichTextDoc): string {
  if (!doc.content) return ''
  return doc.content
    .map(block => (block.content || []).map(n => n.text || '').join(''))
    .join(' ')
}

// --- Color map ---

export const COLOR_HEX: Record<string, string> = {
  yellow: '#eab308',
  red: '#ef4444',
  green: '#22c55e',
  blue: '#3b82f6',
  violet: '#8b5cf6',
  orange: '#f97316',
  grey: '#6b7280',
  'light-red': '#ef4444',
  'light-green': '#22c55e',
  'light-blue': '#3b82f6',
  'light-violet': '#8b5cf6',
  black: '#333',
  white: '#ccc',
}

// --- Review state helpers ---

export type ReviewStatus = 'new' | 'old' | 'discuss' | null
export type ReviewMap = Record<string, ReviewStatus>
export type SummaryMap = Record<string, string>

export const STATUS_LABELS: Array<{ key: ReviewStatus; label: string; symbol: string }> = [
  { key: 'new', label: 'keep new', symbol: '\u25CB' },    // ○
  { key: 'old', label: 'revert', symbol: '\u25CB' },      // ○
  { key: 'discuss', label: 'discuss', symbol: '\u25CB' },  // ○
]

export const STATUS_FILLED = '\u25CF' // ●
