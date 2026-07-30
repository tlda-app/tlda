import fs from 'fs'
import path from 'path'
import { listMarkdownSectionIds, selectMarkdown } from '../../shared/markdown-selector.mjs'

export function markdownSelectionSelector(selector) {
  const value = String(selector ?? '').trim()
  if (!value) return value
  if (/^[A-Za-z][\w:-]*$/.test(value)) return `#${value}`
  return value
}

export function resolveMarkdownSelectorBody(args, {
  cwd = process.env.PWD || process.cwd(),
  bodyField = 'text',
  bodyLabel = 'text',
  extraBodyFields = [],
} = {}) {
  const selectorArg = typeof args.selector === 'string' ? args.selector.trim() : ''
  const hasSelector = Object.prototype.hasOwnProperty.call(args, 'selector') && selectorArg.length > 0
  const hasFile = typeof args.file === 'string' && args.file.trim().length > 0
  const inlineBody = args[bodyField]
  const hasInlineBody = typeof inlineBody === 'string' && inlineBody.length > 0
  const hasExtraBody = extraBodyFields.some(field => {
    const value = args[field]
    return Array.isArray(value) ? value.length > 0 : value != null && value !== ''
  })

  if (!hasSelector && !Object.prototype.hasOwnProperty.call(args, 'selector')) return { skipped: true }
  if (!hasFile) return { error: 'The `file` form needs a `file` path and a `selector`, e.g. "#the-plan", ".app", or "h2".' }
  if (!selectorArg) return { error: 'The `file` form needs a `selector`, e.g. "#the-plan", ".app", or "h2".' }
  if (hasInlineBody || hasExtraBody) return { error: `Provide either \`${bodyField}\` or \`file\`+\`selector\`, not both.` }

  const abs = args.file.startsWith('~')
    ? path.join(process.env.HOME || '', args.file.slice(1))
    : (path.isAbsolute(args.file) ? args.file : path.resolve(cwd, args.file))
  if (!fs.existsSync(abs)) return { error: `File not found: ${abs}` }

  let content
  try { content = fs.readFileSync(abs, 'utf8') }
  catch (e) { return { error: `Could not read ${abs}: ${e.message}` } }

  const selector = markdownSelectionSelector(selectorArg)
  const result = selectMarkdown(content, selector)
  if (result.error) {
    const ids = listMarkdownSectionIds(content)
    const avail = ids.length ? `\nSections in this file: ${ids.join(', ')}` : '\n(no headings found in this file)'
    return { error: `${result.error}${avail}` }
  }

  return {
    body: result.body,
    source: { file: abs, selector: selectorArg },
    bodyField,
    bodyLabel,
  }
}
