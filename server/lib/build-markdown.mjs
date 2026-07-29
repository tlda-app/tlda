/**
 * Markdown build pipeline for tlda.
 *
 * Reads a .md file from sourceDir, renders with markdown-it + KaTeX,
 * wraps in a full HTML page with the tlda bridge script, and writes
 * output/index.html + page-info.json.
 *
 * The output format is identical to the 'html' format — the viewer
 * uses loadHtmlDocument and html-page shapes, same as for Quarto HTML.
 */

import MarkdownIt from 'markdown-it'
import markdownItAnchor from 'markdown-it-anchor'
import katex from 'katex'
import { normalizeChatDisplayMathDelimiters } from '../../shared/chat-math-normalize.mjs'
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from 'fs'
import { join, basename, dirname, posix } from 'path'
import { readProject, listProjects, aggregateBookToc, sourceDir as getSourceDir, outputDir as getOutputDir } from './project-store.mjs'
import { listDocumentColumns, pageInfoFromDocumentColumns } from './document-columns.mjs'
import { getBuildReporter } from './build-runner.mjs'
import { scanMarkdownDependencyClosure } from '../../shared/markdown-deps.mjs'

const FRONTMATTER_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/

export function stripMarkdownFrontmatter(source, { preserveLineNumbers = true } = {}) {
  const text = String(source ?? '')
  const match = text.match(FRONTMATTER_RE)
  if (!match) return text
  if (!preserveLineNumbers) return text.slice(match[0].length)
  return match[0].replace(/[^\r\n]/g, '') + text.slice(match[0].length)
}

function markdownFrontmatter(source) {
  const text = String(source ?? '')
  const match = text.match(FRONTMATTER_RE)
  if (!match) return {}
  const body = match[0].replace(/^---[ \t]*\r?\n/, '').replace(/\r?\n---[ \t]*(?:\r?\n|$)$/, '')
  const values = {}
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/)
    if (m) values[m[1]] = m[2]
  }
  return values
}

// ---- KaTeX math plugin for markdown-it ----

function escapedDollar(state, silent) {
  if (state.src[state.pos] !== '\\') return false
  if (state.src[state.pos + 1] !== '$') return false
  if (!silent) {
    const token = state.push('html_inline', '', 0)
    token.content = '$'
  }
  state.pos += 2
  return true
}

// Extract \newcommand and \DeclareMathOperator from preamble $$ blocks
function extractMacros(source) {
  const macros = {}
  const preambleRe = /\$\$([\s\S]*?)\$\$/g
  let m
  while ((m = preambleRe.exec(source)) !== null) {
    const block = m[1]
    if (!block.includes('\\newcommand') && !block.includes('\\DeclareMathOperator')) continue
    // \newcommand{\name}[nargs]{body}
    for (const cm of block.matchAll(/\\newcommand\{(\\[a-zA-Z]+)\}(?:\[(\d+)\])?\{/g)) {
      const name = cm[1]
      const nargs = parseInt(cm[2] || '0')
      // Find the matching closing brace
      let depth = 1, i = cm.index + cm[0].length
      while (i < block.length && depth > 0) {
        if (block[i] === '{') depth++
        if (block[i] === '}') depth--
        i++
      }
      const body = block.slice(cm.index + cm[0].length, i - 1)
      // Double '#' that aren't argument refs (#1, #2..) — KaTeX uses # for args
      macros[name] = body.replace(/#(?![1-9])/g, '##')
    }
    // \DeclareMathOperator{\name}{text}
    for (const cm of block.matchAll(/\\DeclareMathOperator\*?\{(\\[a-zA-Z]+)\}\{([^}]*)\}/g)) {
      macros[cm[1]] = `\\operatorname{${cm[2]}}`
    }
  }
  return macros
}

let _macros = {}

function mathPlugin(md) {
  // Display math: $$...$$
  md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    let pos = state.bMarks[startLine] + state.tShift[startLine]
    let max = state.eMarks[startLine]
    const src = state.src

    if (src.charCodeAt(pos) !== 0x24 || src.charCodeAt(pos + 1) !== 0x24) return false

    pos += 2
    let firstLine = src.slice(pos, max)

    if (silent) return true

    // Find closing $$
    let nextLine = startLine
    let found = false
    let lastContent = firstLine

    if (firstLine.trimEnd().endsWith('$$')) {
      found = true
      lastContent = firstLine.slice(0, firstLine.lastIndexOf('$$'))
    } else {
      nextLine++
      while (nextLine < endLine) {
        pos = state.bMarks[nextLine] + state.tShift[nextLine]
        max = state.eMarks[nextLine]
        const line = src.slice(pos, max)
        if (line.trimEnd().endsWith('$$')) {
          lastContent = line.slice(0, line.lastIndexOf('$$'))
          found = true
          break
        }
        nextLine++
      }
    }

    if (!found) return false

    // Collect math content
    let mathContent
    if (nextLine === startLine) {
      mathContent = lastContent.trim()
    } else {
      const lines = []
      for (let i = startLine; i <= nextLine; i++) {
        const lp = state.bMarks[i] + state.tShift[i]
        const lm = state.eMarks[i]
        let line = src.slice(lp, lm)
        if (i === startLine) line = line.slice(2)
        if (i === nextLine) line = lastContent
        lines.push(line)
      }
      mathContent = lines.join('\n').trim()
    }

    state.line = nextLine + 1

    const token = state.push('math_block', 'math', 0)
    token.block = true
    token.content = mathContent
    token.map = [startLine, state.line]
    token.markup = '$$'
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })

  // Inline math: $...$
  md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    const src = state.src
    const pos = state.pos
    if (src[pos] !== '$') return false
    if (src[pos + 1] === '$') return false  // not display math start

    // Find closing $
    let end = pos + 1
    while (end < src.length) {
      if (src[end] === '\\') { end += 2; continue }
      if (src[end] === '$') break
      end++
    }
    if (end >= src.length) return false

    const content = src.slice(pos + 1, end)
    if (!content.trim()) return false
    if (!silent) {
      const token = state.push('math_inline', '', 0)
      token.markup = '$'
      token.content = content
    }
    state.pos = end + 1
    return true
  })

  // Render tokens
  md.renderer.rules.math_inline = (tokens, idx) => {
    try {
      return katex.renderToString(tokens[idx].content, { throwOnError: false, strict: false, displayMode: false, macros: { ..._macros } })
    } catch (e) {
      return `<span class="math-error">${tokens[idx].content}</span>`
    }
  }

  md.renderer.rules.math_block = (tokens, idx) => {
    const content = tokens[idx].content
    // Skip preamble-only blocks (just \newcommand/\DeclareMathOperator definitions)
    if (/^[\s\\]*(newcommand|DeclareMathOperator|def\b)/.test(content.trim()) && !content.includes('=')) {
      return '' // suppress preamble block from output
    }
    try {
      return '<p>' + katex.renderToString(content, { throwOnError: false, strict: false, displayMode: true, macros: { ..._macros } }) + '</p>\n'
    } catch (e) {
      return `<p class="math-error">${tokens[idx].content}</p>\n`
    }
  }
}

// ---- Extract title from markdown source ----

function extractTitle(source) {
  const m = source.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : 'Document'
}

function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function splitHtmlParts(html) {
  const tagRe = /<[^>]+>/g
  const parts = []
  let lastIdx = 0
  let m
  while ((m = tagRe.exec(html)) !== null) {
    if (m.index > lastIdx) parts.push({ text: html.slice(lastIdx, m.index), isTag: false })
    parts.push({ text: m[0], isTag: true })
    lastIdx = tagRe.lastIndex
  }
  if (lastIdx < html.length) parts.push({ text: html.slice(lastIdx), isTag: false })
  return parts
}

function linkifyMarkdownTextRefs(html) {
  const parts = splitHtmlParts(html)
  let skipDepth = 0
  const result = []
  const skipOpen = /^<(a|code|pre)[\s>]/i
  const skipClose = /^<\/(a|code|pre|span)>/i
  const spanSkipOpen = /^<span\s[^>]*class="[^"]*(?:doc-link|ref-chip)/i
  const spanOpen = /^<span[\s>]/i
  const refRe = /(?<![\\@\w])@([\w:.-]+[\w])|texsync:\/\/file([^\s<>"']+?):(\d+)/g

  for (const part of parts) {
    if (part.isTag) {
      if (skipDepth > 0) {
        if (spanOpen.test(part.text)) skipDepth++
        else if (skipClose.test(part.text)) skipDepth--
      } else if (skipOpen.test(part.text) || spanSkipOpen.test(part.text)) {
        skipDepth++
      }
      result.push(part.text)
      continue
    }

    if (skipDepth > 0) {
      result.push(part.text)
      continue
    }

    let cursor = 0
    let modified = false
    const segments = []
    refRe.lastIndex = 0
    let m
    while ((m = refRe.exec(part.text)) !== null) {
      modified = true
      if (m.index > cursor) segments.push(part.text.slice(cursor, m.index))
      if (m[1]) {
        const label = m[1]
        segments.push(`<span class="doc-link at-ref" data-ref-type="label" data-ref-label="${escAttr(label)}">@${escAttr(label)}</span>`)
      } else {
        const file = m[2]
        const line = m[3]
        const display = `${basename(file)}:${line}`
        segments.push(`<span class="doc-link texsync-ref" data-ref-type="source-line" data-ref-file="${escAttr(file)}" data-ref-line="${line}">${escAttr(display)}</span>`)
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

function taskDocRenderLayerAssets(enabled, agentNames = []) {
  if (!enabled) return { style: '', script: '' }
  const serializedAgentNames = JSON.stringify(agentNames).replace(/</g, '\\u003c')
  return {
    style: `
    .task-doc-tools {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin: 1rem 0 0.5rem;
      font-size: 0.82rem;
      color: #4b5563;
    }
    .task-doc-tools label {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      white-space: nowrap;
    }
    .task-doc-tools select,
    .task-doc-tools input,
    .task-doc-tools button {
      font: inherit;
      color: inherit;
      border: 1px solid #d1d5db;
      border-radius: 4px;
      background: #fff;
      padding: 0.22rem 0.45rem;
    }
    .task-doc-tools input {
      width: min(18rem, 100%);
    }
    .task-doc-tools button { cursor: pointer; }
    .task-doc-row-count { margin-left: auto; color: #6b7280; }
    body.task-doc-body {
      width: max-content;
      min-width: 100%;
      overflow-x: visible;
    }
    .task-doc-table-wrap {
      width: max-content;
      max-width: none;
      overflow: visible;
    }
    .task-doc-table {
      width: max-content;
      min-width: 0;
      max-width: none;
    }
    .task-doc-table th,
    .task-doc-table td {
      white-space: nowrap;
    }
    .task-doc-table td:nth-child(1),
    .task-doc-table td:nth-child(2) {
      white-space: normal;
      min-width: 14rem;
      max-width: 34rem;
    }
    table.task-doc-table th[data-task-doc-sort] {
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    table.task-doc-table th[data-task-doc-sort]::after {
      content: attr(data-sort-indicator);
      display: inline-block;
      min-width: 1.2em;
      color: #6b7280;
      font-size: 0.85em;
      text-align: right;
    }
    .task-doc-fleet-id {
      border-bottom: 1px dotted #9ca3af;
      cursor: help;
    }
    .task-doc-agent,
    .task-doc-task-subject,
    .task-doc-detail,
    .task-doc-time {
      cursor: help;
    }
    .task-doc-detail {
      color: #4b5563;
    }
    .task-doc-empty-row td {
      color: #6b7280;
      font-style: italic;
    }`,
    script: `
<script>
(() => {
  const SORTABLE = new Set(['project', 'status', 'created', 'updated', 'last-modified'])
  const FILTERABLE = new Set(['project', 'status'])

  function norm(value) {
    return String(value || '').trim().toLowerCase()
  }

  function displayNameFor(value, exactNames, prefixNames) {
    const id = String(value || '').trim()
    if (!id.startsWith('fleet:')) return null
    if (exactNames.has(id)) return exactNames.get(id)
    const dash = id.indexOf('-')
    if (dash > 0) {
      const prefix = id.slice(0, dash)
      const name = prefixNames.get(prefix)
      if (name) return name + '-' + id.slice(dash + 1)
    }
    return null
  }

  function parseTime(value) {
    const text = String(value || '').trim()
    if (!text) return 0
    const parsed = Date.parse(text.replace(/ UTC$/, 'Z'))
    return Number.isNaN(parsed) ? 0 : parsed
  }

  function tableState(table) {
    const headers = Array.from(table.tHead?.rows?.[0]?.cells || [])
    const body = table.tBodies[0] || table.appendChild(document.createElement('tbody'))
    const columns = headers.map(th => norm(th.textContent))
    return {
      headers,
      columns,
      body,
      rows: Array.from(body.rows || []),
      sort: columns.includes('updated')
        ? { column: 'updated', dir: 'desc' }
        : { column: null, dir: 'asc' },
      filters: { project: '', status: '', search: '' },
      emptyRow: null,
    }
  }

  function rowValue(row, state, column) {
    const idx = state.columns.indexOf(column)
    return idx >= 0 ? row.cells[idx]?.dataset.rawValue || row.cells[idx]?.textContent || '' : ''
  }

  function compareRows(a, b, state, column, dir) {
    const av = rowValue(a, state, column)
    const bv = rowValue(b, state, column)
    let delta
    if (column === 'created' || column === 'updated' || column === 'last-modified') {
      delta = parseTime(av) - parseTime(bv)
    } else {
      delta = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' })
    }
    return dir === 'desc' ? -delta : delta
  }

  function update(table, state) {
    let visible = 0
    for (const row of state.rows) {
      const projectOk = !state.filters.project || rowValue(row, state, 'project') === state.filters.project
      const statusOk = !state.filters.status || rowValue(row, state, 'status') === state.filters.status
      const searchOk = !state.filters.search || norm(row.textContent).includes(state.filters.search)
      const show = projectOk && statusOk && searchOk
      row.hidden = !show
      if (show) visible += 1
    }
    if (state.sort.column) {
      const sorted = [...state.rows].sort((a, b) => compareRows(a, b, state, state.sort.column, state.sort.dir))
      for (const row of sorted) state.body.appendChild(row)
    }
    if (state.emptyRow) {
      state.body.appendChild(state.emptyRow)
      state.emptyRow.hidden = visible !== 0
    }
    const count = table.previousElementSibling?.querySelector?.('.task-doc-row-count')
    if (count) count.textContent = visible + ' shown'
    for (const th of state.headers) {
      const column = norm(th.textContent)
      const active = state.sort.column === column
      th.dataset.sortIndicator = active ? (state.sort.dir === 'asc' ? '▲' : '▼') : ''
      th.setAttribute('aria-sort', active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none')
    }
  }

  function addControls(table, state) {
    const controls = document.createElement('div')
    controls.className = 'task-doc-tools'
    for (const column of ['project', 'status']) {
      if (!FILTERABLE.has(column) || !state.columns.includes(column)) continue
      const label = document.createElement('label')
      label.textContent = column + ' '
      const select = document.createElement('select')
      select.dataset.taskDocFilter = column
      const all = document.createElement('option')
      all.value = ''
      all.textContent = 'all'
      select.appendChild(all)
      const values = [...new Set(state.rows.map(row => rowValue(row, state, column)).filter(Boolean))].sort((a, b) => a.localeCompare(b))
      for (const value of values) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = value
        select.appendChild(option)
      }
      select.addEventListener('change', () => {
        state.filters[column] = select.value
        update(table, state)
      })
      label.appendChild(select)
      controls.appendChild(label)
    }
    const searchLabel = document.createElement('label')
    searchLabel.textContent = 'search '
    const search = document.createElement('input')
    search.type = 'search'
    search.placeholder = 'find task'
    search.dataset.taskDocFilter = 'search'
    search.addEventListener('input', () => {
      state.filters.search = norm(search.value)
      update(table, state)
    })
    searchLabel.appendChild(search)
    controls.appendChild(searchLabel)
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.textContent = 'reset'
    clear.addEventListener('click', () => {
      state.filters.project = ''
      state.filters.status = ''
      state.filters.search = ''
      for (const select of controls.querySelectorAll('select')) select.value = ''
      for (const input of controls.querySelectorAll('input')) input.value = ''
      update(table, state)
    })
    controls.appendChild(clear)
    const count = document.createElement('span')
    count.className = 'task-doc-row-count'
    controls.appendChild(count)
    table.before(controls)
  }

  function addSorting(table, state) {
    for (const th of state.headers) {
      const column = norm(th.textContent)
      if (!SORTABLE.has(column)) continue
      th.dataset.taskDocSort = column
      th.tabIndex = 0
      th.setAttribute('role', 'button')
      th.setAttribute('aria-sort', 'none')
      const activate = () => {
        if (state.sort.column === column) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc'
        else state.sort = { column, dir: column === 'created' || column === 'updated' || column === 'last-modified' ? 'desc' : 'asc' }
        update(table, state)
      }
      th.addEventListener('click', activate)
      th.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          activate()
        }
      })
    }
  }

  function addEmptyRow(table, state) {
    const tr = document.createElement('tr')
    tr.className = 'task-doc-empty-row'
    tr.hidden = true
    const td = document.createElement('td')
    td.colSpan = state.columns.length
    td.textContent = 'No tasks match the current filters.'
    tr.appendChild(td)
    state.body.appendChild(tr)
    state.emptyRow = tr
  }

  function captureRawValues(state) {
    for (const row of state.rows) {
      Array.from(row.cells).forEach(cell => {
        const time = cell.querySelector('time[datetime]')
        cell.dataset.rawValue = time?.getAttribute('datetime') || cell.textContent.trim()
      })
    }
  }

  function formatLocalTimes(table) {
    const now = new Date()
    const currentYear = now.getFullYear()
    for (const el of table.querySelectorAll('time.task-doc-time[datetime]')) {
      const iso = el.getAttribute('datetime')
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) continue
      const sameYear = date.getFullYear() === currentYear
      el.textContent = new Intl.DateTimeFormat(undefined, {
        ...(sameYear ? {} : { year: 'numeric' }),
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(date)
      el.title = new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(date)
    }
  }

  function collectFleetIds(state) {
    const ids = new Set()
    for (const column of ['id', 'owner', 'assigned to', 'delegator']) {
      const idx = state.columns.indexOf(column)
      if (idx < 0) continue
      for (const row of state.rows) {
        const raw = row.cells[idx]?.dataset.rawValue || ''
        if (/^fleet:[A-Za-z0-9_.:-]+$/.test(raw)) ids.add(raw)
      }
    }
    return [...ids].slice(0, 200)
  }

  function loadAgentNames(state) {
    const ids = collectFleetIds(state)
    if (!ids.length) return { exactNames: new Map(), prefixNames: new Map() }
    const requested = new Set(ids)
    const exactNames = new Map()
    const prefixNames = new Map()
    for (const agent of ${serializedAgentNames}) {
      if (!agent?.id || !requested.has(agent.id)) continue
      const display = agent.pretty_name || agent.friendly_name || agent.lineage_name || agent.id
      exactNames.set(agent.id, display)
      prefixNames.set(agent.id.slice(0, 10), display)
    }
    return { exactNames, prefixNames }
  }

  function prettyPrintFleetIds(table, state, names) {
    for (const column of ['id', 'owner', 'assigned to', 'delegator']) {
      const idx = state.columns.indexOf(column)
      if (idx < 0) continue
      for (const row of state.rows) {
        const cell = row.cells[idx]
        const raw = cell?.dataset.rawValue || ''
        const display = displayNameFor(raw, names.exactNames, names.prefixNames)
        if (!display || display === raw) continue
        cell.textContent = display
        cell.title = raw
        cell.classList.add('task-doc-fleet-id')
      }
    }
  }

  function enhance(table) {
    if (table.dataset.taskDocEnhanced) return
    const state = tableState(table)
    if (!state.columns.includes('subject') || !state.columns.includes('status')) return
    table.dataset.taskDocEnhanced = 'true'
    table.classList.add('task-doc-table')
    wrapTable(table)
    formatLocalTimes(table)
    captureRawValues(state)
    addControls(table, state)
    addSorting(table, state)
    addEmptyRow(table, state)
    update(table, state)
    prettyPrintFleetIds(table, state, loadAgentNames(state))
  }

  function wrapTable(table) {
    if (table.parentElement?.classList?.contains('task-doc-table-wrap')) return
    const wrap = document.createElement('div')
    wrap.className = 'task-doc-table-wrap'
    table.before(wrap)
    wrap.appendChild(table)
  }

  document.addEventListener('DOMContentLoaded', () => {
    for (const table of document.querySelectorAll('table')) enhance(table)
  })
})()
</script>`,
  }
}

function enhanceTexsyncAnchors(html) {
  return html.replace(/<a\b([^>]*?)\bhref="texsync:\/\/file([^"]+?):(\d+)"([^>]*)>/g, (_m, before, file, line, after) => {
    const attrs = `${before} href="texsync://file${escAttr(file)}:${line}"${after}`
    const classMatch = attrs.match(/\bclass="([^"]*)"/)
    const withClass = classMatch
      ? attrs.replace(/\bclass="([^"]*)"/, `class="${classMatch[1]} doc-link texsync-ref"`)
      : `${attrs} class="doc-link texsync-ref"`
    return `<a${withClass} data-ref-type="source-line" data-ref-file="${escAttr(file)}" data-ref-line="${line}">`
  })
}

function linkifyMarkdownDocRefs(html) {
  return enhanceTexsyncAnchors(linkifyMarkdownTextRefs(html))
}

function installLineAnchorPlugin(md) {
  const defaultOpen = (type) => {
    const original = md.renderer.rules[type]
    md.renderer.rules[type] = (tokens, idx, options, env, self) => {
      const token = tokens[idx]
      if (token.map && token.map[0] != null) {
        token.attrSet('id', `line-${token.map[0] + 1}`)
      }
      return original ? original(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)
    }
  }
  for (const tag of ['paragraph_open', 'heading_open', 'blockquote_open', 'bullet_list_open', 'ordered_list_open', 'table_open', 'hr']) {
    defaultOpen(tag)
  }
}

function markdownPathToHtmlPath(file) {
  const clean = String(file || '').replace(/\\/g, '/').replace(/^\/+/, '')
  return clean.replace(/\.(md|markdown)$/i, '.html')
}

function rewriteMarkdownHrefTargets(html, { projectName = null, sourceFile = null, mainFile = null } = {}) {
  return html.replace(/\bhref="([^"]+\.(?:md|markdown)(?:[?#][^"]*)?)"/gi, (_m, href) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return `href="${escAttr(href)}"`
    const match = String(href).match(/^([^?#]+)(\?[^#]*)?(#.*)?$/)
    if (!match) return `href="${escAttr(href)}"`
    const [, path, query = '', hash = ''] = match
    const targetSource = sourceFile
      ? posix.normalize(posix.join(posix.dirname(sourceFile.replace(/\\/g, '/')), path))
      : path
    if (targetSource.startsWith('../') || targetSource.startsWith('/')) return `href="${escAttr(href)}"`
    const normalizedMain = String(mainFile || '').replace(/\\/g, '/').replace(/^\/+/, '')
    const targetHtml = targetSource === normalizedMain ? 'index.html' : markdownPathToHtmlPath(targetSource)
    const next = projectName
      ? `/docs/${encodeURIComponent(projectName)}/${targetHtml.split('/').map(encodeURIComponent).join('/')}`
      : markdownPathToHtmlPath(path)
    return `href="${escAttr(`${next}${query}${hash}`)}"`
  })
}

function markdownTocForSource(source, page) {
  const renderSource = normalizeChatDisplayMathDelimiters(stripMarkdownFrontmatter(source))
  const slugify = s => s.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')
  const levels = { 1: 'section', 2: 'subsection', 3: 'subsubsection', 4: 'subsubsection' }
  const toc = []
  const mdToc = new MarkdownIt()
  const tocTokens = mdToc.parse(renderSource, {})
  for (let i = 0; i < tocTokens.length; i++) {
    if (tocTokens[i].type !== 'heading_open') continue
    const level = parseInt(tocTokens[i].tag.slice(1))
    const inlineToken = tocTokens[i + 1]
    let headingTitle = inlineToken?.children?.map(t => t.content).join('') || ''
    const explicitId = headingTitle.match(/\{#([\w-]+)\}/)
    if (explicitId) headingTitle = headingTitle.replace(/\s*\{#[\w-]+\}/, '').trim()
    const anchor = slugify(headingTitle)
    if (level <= 4 && headingTitle && anchor) {
      toc.push({ title: headingTitle, level: levels[level] || 'subsubsection', page, anchor })
    }
  }
  return toc
}

export function renderMarkdownColumnHtml({ source, title, isTaskDoc, agentNames = [], projectName = null, sourceFile = null, mainFile = null }) {
  _macros = extractMacros(source)
  const renderSource = normalizeChatDisplayMathDelimiters(stripMarkdownFrontmatter(source))
  const slugify = s => s.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')
  const processedSource = renderSource.replace(/(^#{1,6}[^\n]*?)\s*\{#[\w-]+\}/gm, '$1')
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true })
    .use(mathPlugin)
    .use(markdownItAnchor, { slugify })
  let mermaidIndex = 0
  const defaultFence = md.renderer.rules.fence || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const info = token.info ? token.info.trim().split(/\s+/)[0].toLowerCase() : ''
    if (info !== 'mermaid') return defaultFence(tokens, idx, options, env, self)
    const id = `mermaid-${mermaidIndex++}`
    const lineCount = token.content.split(/\r?\n/).filter(Boolean).length
    const minHeight = Math.min(1200, Math.max(360, lineCount * 28))
    return `<div class="tlda-mermaid-placeholder" data-tlda-mermaid-id="${id}" style="min-height:${minHeight}px"><template data-tlda-mermaid-source>${escHtml(token.content)}</template></div>\n`
  }
  installLineAnchorPlugin(md)
  const env = {}
  const tokens = md.parse(processedSource, env)
  let content = md.renderer.render(tokens, md.options, env)
  content = rewriteMarkdownHrefTargets(linkifyMarkdownDocRefs(content), { projectName, sourceFile, mainFile })
  const taskDocAssets = taskDocRenderLayerAssets(isTaskDoc, agentNames)
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css">
  <style>
    html, body { background: transparent; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: 0.875rem; font-weight: 400; line-height: 1.5; color: #212529; max-width: none; margin: 0; padding: 48px 40px 80px; }
    h1, h2, h3, h4 { font-weight: 500; line-height: 1.25; margin-top: 1.8em; margin-bottom: 0.5em; }
    h1 { font-size: 1.8em; margin-top: 0; }
    h2 { font-size: 1.35em; }
    h3 { font-size: 1.1em; }
    p { margin: 0 0 1em; }
    pre { background: #f5f5f5; padding: 1em; border-radius: 4px; overflow-x: auto; font-size: 0.88em; }
    code { font-family: 'SF Mono', 'Fira Mono', monospace; font-size: 0.9em; background: rgba(0,0,0,0.06); padding: 0.1em 0.35em; border-radius: 3px; }
    pre code { background: none; padding: 0; }
    blockquote { margin: 1em 0; padding: 0 0 0 1em; border-left: 3px solid #ccc; color: #555; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th, td { border: 1px solid #ddd; padding: 0.5em 0.75em; text-align: left; }
    th { background: #f5f5f5; font-weight: 500; }
    img { max-width: 100%; height: auto; }
    div[style*="flex"] { max-width: none; width: max-content; }
    div[style*="flex"] img { max-width: none; height: 360px; width: auto; }
    a { color: #2563eb; }
    .doc-link { color: #2563eb; cursor: pointer; border-bottom: 1px dotted currentColor; text-decoration: none; }
    .doc-link:hover { opacity: 0.72; }
    .katex-display { overflow-x: auto; overflow-y: hidden; }
    .math-error { color: red; font-family: monospace; }
    .tlda-mermaid-placeholder { margin: 1.4em 0; width: 100%; }
${taskDocAssets.style}
  </style>
</head>
<body${isTaskDoc ? ' class="task-doc-body"' : ''}>
${content}
${taskDocAssets.script}
</body>
</html>`
}

// ---- Main build function ----

export async function buildMarkdownDocument(name, addLog = console.log) {
  const reporter = getBuildReporter()
  const srcDir = getSourceDir(name)
  const outDir = getOutputDir(name)

  // Find the main markdown file
  const project = await readProject(name)
  const mainFile = project.mainFile || 'index.md'
  const srcFile = join(srcDir, mainFile)

  addLog(`[markdown] Reading ${srcFile}`)

  let source
  try {
    source = readFileSync(srcFile, 'utf8')
  } catch (e) {
    addLog(`[markdown] Error reading source: ${e.message}`)
    await reporter.updateProject(name, { buildStatus: 'error' })
    return
  }

  mkdirSync(outDir, { recursive: true })
  const columns = await listDocumentColumns(name, { project, srcDir })
  const closure = scanMarkdownDependencyClosure(mainFile, srcDir)
  const toc = []
  for (let i = 0; i < columns.length; i++) {
    const columnSource = readFileSync(join(srcDir, columns[i].sourceFile), 'utf8')
    toc.push(...markdownTocForSource(columnSource, i + 1))
  }

  for (const rel of closure.assets) {
    const from = join(srcDir, rel)
    const to = join(outDir, rel)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to)
  }


  // Write relevant-files.json — the markdown analog of .fls, and the same
  // interface every other format uses. Entries are PROJECT-RELATIVE, so they
  // name the same file in the server mirror, on the author's machine, and in
  // the version; each consumer joins them against the root it holds.
  //
  // Scope is decided here, as it is in the LaTeX emitter: a reference that does
  // not resolve to a file inside this project is not part of the document and
  // never enters a version. That is why an external part's absolute source path
  // is not written out — it belongs to the project that owns it.
  writeFileSync(
    join(outDir, 'relevant-files.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), files: closure.files }, null, 2),
  )

  const pageInfo = pageInfoFromDocumentColumns(name, columns)
  writeFileSync(join(outDir, 'page-info.json'), JSON.stringify(pageInfo, null, 2))
  writeFileSync(join(outDir, 'toc.json'), JSON.stringify(toc, null, 2))

  const buildReadyAt = Date.now()
  await reporter.updateProject(name, { buildStatus: 'success', pages: pageInfo.length, lastBuild: new Date(buildReadyAt).toISOString() })
  // The sentinel is written by recordBuildVersion, with the real commit hash.
  reporter.broadcastSignal(`doc-${name}`, 'signal:reload', { pages: pageInfo.length, timestamp: buildReadyAt })

  // Re-aggregate any book that contains this doc as a member
  for (const proj of await listProjects()) {
    if (proj.format === 'book' && (proj.members || []).includes(name)) {
      aggregateBookToc(proj.name, proj.members)
    }
  }

  addLog(`[markdown] ${name}: indexed ${pageInfo.length} column${pageInfo.length === 1 ? '' : 's'}`)
}
