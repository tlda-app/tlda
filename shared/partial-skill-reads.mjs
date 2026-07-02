import fs from 'fs'
import path from 'path'
import { skillKeyFromSkillMdPath } from './skill-paths.mjs'

function shellWords(command) {
  const words = []
  let cur = ''
  let quote = null
  let escaped = false
  for (const ch of String(command || '')) {
    if (escaped) {
      cur += ch
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (cur) { words.push(cur); cur = '' }
      continue
    }
    if (ch === ';' || ch === '|' || ch === '&') {
      if (cur) { words.push(cur); cur = '' }
      words.push(ch)
      continue
    }
    cur += ch
  }
  if (cur) words.push(cur)
  return words
}

function normalizePath(filePath, cwd = process.cwd()) {
  const raw = String(filePath || '')
  if (!raw) return ''
  if (raw.startsWith('~/')) return path.join(process.env.HOME || '', raw.slice(2))
  return path.resolve(cwd || process.cwd(), raw)
}

function lineCount(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  if (text.length === 0) return 0
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

function parsePositiveInt(value) {
  const n = Number.parseInt(String(value || ''), 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function parseSedAddress(addr, totalLines) {
  if (addr === '$') return totalLines
  return parsePositiveInt(addr)
}

function parseSedRange(words, totalLines, cwd) {
  const exprs = []
  const files = []
  for (let i = 1; i < words.length; i++) {
    const word = words[i]
    if (word === '-n' || word === '-E' || word === '-r') continue
    if (word.startsWith('-n') && word.length > 2) {
      exprs.push(word.slice(2))
      continue
    }
    if (word.startsWith('-e')) {
      if (word === '-e') exprs.push(words[++i] || '')
      else exprs.push(word.slice(2))
      continue
    }
    if (word.startsWith('-')) continue
    if (/[,$0-9]p$/.test(word)) exprs.push(word)
    else files.push(normalizePath(word, cwd))
  }
  if (exprs.length === 0 || files.length === 0) return []
  const ranges = []
  for (const expr of exprs) {
    const m = String(expr).trim().match(/^(\d+|\$)(?:,(\d+|\$))?p$/)
    if (!m) continue
    const start = parseSedAddress(m[1], totalLines)
    const end = parseSedAddress(m[2] || m[1], totalLines)
    if (!start || !end || start > end) continue
    for (const filePath of files) ranges.push({ filePath, start, end })
  }
  return ranges
}

function parseHeadRange(words, totalLines, cwd) {
  let n = 10
  const files = []
  for (let i = 1; i < words.length; i++) {
    const word = words[i]
    if (word === '-n') {
      n = parsePositiveInt(words[++i]) || n
      continue
    }
    const compact = word.match(/^-n(\d+)$/) || word.match(/^-(\d+)$/)
    if (compact) {
      n = parsePositiveInt(compact[1]) || n
      continue
    }
    if (word.startsWith('-')) continue
    files.push(normalizePath(word, cwd))
  }
  return files.map(filePath => ({ filePath, start: 1, end: Math.min(n, totalLines) }))
}

function parseTailRange(words, totalLines, cwd) {
  let spec = '10'
  const files = []
  for (let i = 1; i < words.length; i++) {
    const word = words[i]
    if (word === '-n') {
      spec = words[++i] || spec
      continue
    }
    const compact = word.match(/^-n(.+)$/) || word.match(/^-(\d+)$/)
    if (compact) {
      spec = compact[1]
      continue
    }
    if (word.startsWith('-')) continue
    files.push(normalizePath(word, cwd))
  }
  let start = 1
  let end = totalLines
  if (String(spec).startsWith('+')) {
    start = parsePositiveInt(String(spec).slice(1)) || 1
  } else {
    const n = parsePositiveInt(spec) || 10
    start = Math.max(1, totalLines - n + 1)
  }
  return files.map(filePath => ({ filePath, start, end }))
}

export function parsePartialSkillReadCommand(command, options = {}) {
  const words = shellWords(command)
  const cwd = options.cwd || process.cwd()
  const ranges = []
  for (let i = 0; i < words.length; i++) {
    const tool = path.basename(words[i])
    if (tool !== 'sed' && tool !== 'head' && tool !== 'tail') continue
    const segment = [tool]
    for (let j = i + 1; j < words.length && words[j] !== ';' && words[j] !== '|' && words[j] !== '&'; j++) {
      segment.push(words[j])
    }
    const candidateFiles = segment.slice(1).filter(w => !w.startsWith('-')).map(w => normalizePath(w, cwd))
    for (const filePath of candidateFiles) {
      const skillKey = skillKeyFromSkillMdPath(filePath)
      if (!skillKey) continue
      let totalLines = 0
      try { totalLines = lineCount(filePath) } catch { continue }
      const parsed = tool === 'sed'
        ? parseSedRange(segment, totalLines, cwd)
        : tool === 'head'
          ? parseHeadRange(segment, totalLines, cwd)
          : parseTailRange(segment, totalLines, cwd)
      for (const range of parsed) {
        if (range.filePath !== filePath) continue
        ranges.push({ ...range, skillKey, totalLines })
      }
    }
  }
  return ranges
}

function coversWholeFile(ranges, totalLines) {
  return missingRanges(ranges, totalLines).length === 0
}

export function missingRanges(ranges, totalLines) {
  if (totalLines === 0) return []
  const sorted = ranges
    .map(r => ({ start: Math.max(1, r.start), end: Math.min(totalLines, r.end) }))
    .filter(r => r.start <= r.end)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const missing = []
  let coveredTo = 0
  for (const range of sorted) {
    if (range.start > coveredTo + 1) missing.push({ start: coveredTo + 1, end: range.start - 1 })
    coveredTo = Math.max(coveredTo, range.end)
  }
  if (coveredTo < totalLines) missing.push({ start: coveredTo + 1, end: totalLines })
  return missing
}

export function coveredLineCount(ranges, totalLines) {
  const missing = missingRanges(ranges, totalLines)
  const missingCount = missing.reduce((sum, r) => sum + r.end - r.start + 1, 0)
  return Math.max(0, totalLines - missingCount)
}

export function partialSkillReadSummaries(partialReadsByAgent, agentId) {
  const out = []
  for (const [key, rec] of partialReadsByAgent.entries()) {
    const keyAgent = String(key).split('\0')[0]
    if (keyAgent !== agentId) continue
    if (!rec.totalLines) continue
    const missing = missingRanges(rec.ranges, rec.totalLines)
    const coveredLines = coveredLineCount(rec.ranges, rec.totalLines)
    if (coveredLines <= 0 || missing.length === 0) continue
    out.push({
      skill: rec.skillKey.startsWith('skill:') ? rec.skillKey.slice('skill:'.length) : rec.skillKey,
      skillKey: rec.skillKey,
      filePath: rec.filePath,
      coveredLines,
      totalLines: rec.totalLines,
      percent: Math.round((coveredLines / rec.totalLines) * 100),
      ranges: rec.ranges.slice(),
      missing,
    })
  }
  return out.sort((a, b) => a.skill.localeCompare(b.skill))
}

export function recordPartialSkillReads(partialReadsByAgent, agentId, command, onComplete, options = {}) {
  if (!agentId || !command) return []
  const completed = []
  for (const range of parsePartialSkillReadCommand(command, options)) {
    const key = `${agentId}\0${range.filePath}`
    let rec = partialReadsByAgent.get(key)
    if (!rec) {
      rec = { skillKey: range.skillKey, filePath: range.filePath, totalLines: range.totalLines, ranges: [] }
      partialReadsByAgent.set(key, rec)
    }
    rec.totalLines = range.totalLines
    rec.skillKey = range.skillKey
    rec.filePath = range.filePath
    rec.ranges.push({ start: range.start, end: range.end })
    if (coversWholeFile(rec.ranges, rec.totalLines)) {
      onComplete?.(agentId, rec.skillKey, range.filePath)
      completed.push({ agentId, skillKey: rec.skillKey, filePath: range.filePath })
    }
  }
  return completed
}
