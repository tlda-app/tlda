import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, statSync } from 'fs'
import { dirname, join, relative } from 'path'

const TEX_BUILD_JUNK = /\.(aux|log|toc|bbl|blg|fls|fdb_latexmk|out|synctex\.gz|nav|snm|vrb|dvi|pdf|fmt)$/i
const UNSAFE_ENVS = new Set([
  'align', 'align*', 'alignat', 'alignat*', 'flalign', 'flalign*',
  'gather', 'gather*', 'multline', 'multline*', 'equation', 'equation*',
  'displaymath', 'math',
])

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function beginsUnsafeEnv(line) {
  const m = line.match(/\\begin\{([^}]+)\}/)
  return m && UNSAFE_ENVS.has(m[1]) ? m[1] : null
}

function endsUnsafeEnv(line) {
  const m = line.match(/\\end\{([^}]+)\}/)
  return m && UNSAFE_ENVS.has(m[1]) ? m[1] : null
}

function hasUnescapedPercent(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '%') continue
    let slashCount = 0
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashCount++
    if (slashCount % 2 === 0) return true
  }
  return false
}

function hasUnescapedDollar(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '$') continue
    let slashCount = 0
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashCount++
    if (slashCount % 2 === 0) return true
  }
  return false
}

function isStructuralLine(line) {
  const t = line.trim()
  if (!t) return true
  if (hasUnescapedPercent(line)) return true
  if (t.startsWith('\\')) return true
  if (hasUnescapedDollar(line)) return true
  if (t.includes('$$') || t.includes('\\[') || t.includes('\\]')) return true
  return false
}

export function reflowTexSourceByWord(source, file) {
  const lines = source.split('\n')
  const out = []
  const lineMap = []
  let unsafeEnv = null

  const push = (text, origLine, startCol, endCol, flags = {}) => {
    out.push(text)
    lineMap.push({
      generatedLine: out.length,
      file,
      line: origLine,
      startCol,
      endCol,
      text,
      ...flags,
    })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const origLine = i + 1
    const begin = beginsUnsafeEnv(line)
    if (unsafeEnv || begin || isStructuralLine(line)) {
      push(line, origLine, 0, line.length, { unsafe: !!(unsafeEnv || begin), structural: !unsafeEnv && !begin })
      if (begin) unsafeEnv = begin
      const end = endsUnsafeEnv(line)
      if (unsafeEnv && end === unsafeEnv) unsafeEnv = null
      continue
    }

    const re = /\S+/g
    let m
    let found = false
    while ((m = re.exec(line)) !== null) {
      found = true
      push(m[0], origLine, m.index, m.index + m[0].length)
    }
    if (!found) push(line, origLine, 0, line.length, { structural: true })
  }

  return { text: out.join('\n'), lineMap }
}

export function generateWordSynctexSourceTree(srcDir, mainFile, destDir) {
  mkdirSync(destDir, { recursive: true })
  cpSync(srcDir, destDir, {
    recursive: true,
    filter: (src) => {
      try {
        if (statSync(src).isFile() && TEX_BUILD_JUNK.test(src)) return false
      } catch {
        // If a file disappears while copying the source tree, leave it to cpSync
        // to report the real copy failure rather than silently excluding paths.
      }
      return true
    },
  })

  const lineMap = []
  for (const full of walk(destDir)) {
    if (!full.endsWith('.tex')) continue
    const rel = relative(destDir, full)
    const originalPath = join(srcDir, rel)
    if (!existsSync(originalPath)) continue
    const { text, lineMap: fileMap } = reflowTexSourceByWord(readFileSync(originalPath, 'utf8'), rel)
    writeFileSync(full, text)
    lineMap.push(...fileMap)
  }

  return {
    version: 1,
    mainFile,
    generatedAt: new Date().toISOString(),
    lineMap,
  }
}
