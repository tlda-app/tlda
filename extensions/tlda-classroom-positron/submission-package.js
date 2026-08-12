const path = require('node:path')
const { zipSync } = require('fflate')

const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^)>\s]+)>?[^)]*\)/g
const ANSWER_ID = /:::\s*\{[^}]*#(ans-[A-Za-z0-9_-]+)[^}]*\}/g
const REMOTE = /^(https?:|data:|mailto:|#)/i

function withoutCode(source) {
  return source
    .replace(/^[ \t]*(```+|~~~+)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '')
}

function parseQmdReferences(source) {
  const images = []
  for (const match of withoutCode(source).matchAll(MARKDOWN_IMAGE)) {
    const target = decodeURIComponent(match[1].trim())
    if (!REMOTE.test(target)) images.push(target)
  }
  const answerIds = [...source.matchAll(ANSWER_ID)].map(match => match[1])
  return { images, answerIds }
}

function safeRelativeAsset(target) {
  const normalized = path.posix.normalize(target.replaceAll('\\', '/'))
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`The image path ${target} leaves the assignment folder. Put the image beside the QMD and use a relative path.`)
  }
  return normalized
}

async function buildSubmissionArchive({ qmdName, source, readAsset }) {
  const { images, answerIds } = parseQmdReferences(source)
  if (answerIds.length === 0) {
    throw new Error('This QMD has no answer blocks. Use the assignment handout and write inside its answer blocks.')
  }

  const entries = { [qmdName]: new Uint8Array(Buffer.from(source)) }
  for (const target of [...new Set(images)]) {
    const relative = safeRelativeAsset(target)
    try {
      entries[relative] = await readAsset(relative)
    } catch (error) {
      if (error && error.code === 'FileNotFound') {
        throw new Error(`The QMD refers to ${target}, but that file is missing. Put it beside the QMD before creating the ZIP.`)
      }
      throw error
    }
  }

  return {
    bytes: zipSync(entries),
    files: Object.keys(entries),
    answerIds,
  }
}

module.exports = { buildSubmissionArchive, parseQmdReferences, safeRelativeAsset }
