const path = require('node:path')
const { zipSync } = require('fflate')

const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^)>\s]+)>?[^)]*\)/g
const QUARTO_INCLUDE = /\{\{<\s*include\s+(?:"([^"]+)"|'([^']+)'|([^\s>]+))\s*>\}\}/g
const ANSWER_ID = /:::\s*\{[^}]*#(ans-[A-Za-z0-9_-]+)[^}]*\}/g
const REMOTE = /^(https?:|data:|mailto:|#)/i

function withoutCode(source) {
  return source
    .replace(/^[ \t]*(```+|~~~+)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '')
}

function parseQmdReferences(source) {
  const images = []
  const includes = []
  const prose = withoutCode(source)
  for (const match of prose.matchAll(MARKDOWN_IMAGE)) {
    const target = decodeURIComponent(match[1].trim())
    if (!REMOTE.test(target)) images.push(target)
  }
  for (const match of prose.matchAll(QUARTO_INCLUDE)) {
    const target = decodeURIComponent((match[1] || match[2] || match[3]).trim())
    if (!REMOTE.test(target)) includes.push(target)
  }
  const answerIds = [...source.matchAll(ANSWER_ID)].map(match => match[1])
  return { images, includes, answerIds }
}

function safeRelativeAsset(target) {
  const normalized = path.posix.normalize(target.replaceAll('\\', '/'))
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`The referenced path ${target} leaves the assignment folder. Put the file beside the QMD and use a relative path.`)
  }
  return normalized
}

async function buildSubmissionArchive({ qmdName, source, readAsset }) {
  const { answerIds } = parseQmdReferences(source)
  if (answerIds.length === 0) {
    throw new Error('This QMD has no answer blocks. Use the assignment handout and write inside its answer blocks.')
  }

  const entries = { [qmdName]: new Uint8Array(Buffer.from(source)) }
  const pending = [{ name: qmdName, source }]
  const visited = new Set([qmdName])
  while (pending.length) {
    const current = pending.shift()
    const base = path.posix.dirname(current.name)
    const { images, includes } = parseQmdReferences(current.source)
    for (const target of [...new Set([...images, ...includes])]) {
      const relative = safeRelativeAsset(base === '.' ? target : `${base}/${target}`)
      if (visited.has(relative)) continue
      visited.add(relative)
      let bytes
      try {
        bytes = await readAsset(relative)
      } catch (error) {
        if (error && error.code === 'FileNotFound') {
          throw new Error(`The QMD refers to ${target}, but that file is missing. Put it beside the QMD before creating the ZIP.`)
        }
        throw error
      }
      entries[relative] = bytes
      if (includes.includes(target)) {
        pending.push({ name: relative, source: Buffer.from(bytes).toString('utf8') })
      }
    }
  }

  return {
    bytes: zipSync(entries),
    files: Object.keys(entries),
    answerIds,
  }
}

module.exports = { buildSubmissionArchive, parseQmdReferences, safeRelativeAsset }
