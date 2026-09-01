'use strict'
const fs = require('fs')
const path = require('path')

function answerBaseline(file, source) {
  const header = source.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)?.[1] || ''
  const value = header.match(/^tlda-answer-baseline:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim()
  if (!value) return undefined

  const root = path.dirname(file)
  const target = path.resolve(root, value)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return undefined
  try { return fs.readFileSync(target, 'utf8') } catch { return undefined }
}

module.exports = { answerBaseline }
