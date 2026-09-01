'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { install, marker } = require('../src/visual-mode-css')

test('installs the homework callout palette in Quarto visual mode exactly once', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-classroom-visual-css-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const editor = path.join(root, 'assets', 'www', 'editor')
  fs.mkdirSync(editor, { recursive: true })
  const stylesheet = path.join(editor, 'style.css')
  fs.writeFileSync(stylesheet, '.ProseMirror{}')

  assert.equal(install(root), true)
  assert.equal(install(root), false)

  const result = fs.readFileSync(stylesheet, 'utf8')
  assert.equal(result.split(marker).length - 1, 1)
  assert.match(result, /\.callout-exercise[^}]+64, 224, 208/s)
  assert.match(result, /\.callout-answer,[^}]+255, 105, 180/s)
  assert.match(result, /\.callout-solution[^}]+255, 105, 180/s)
  assert.match(result, /\.callout-note[^}]+#0d6efd/s)
  assert.match(result, /\.callout-tip[^}]+#198754/s)
  assert.match(result, /\.callout-warning[^}]+#ffc107/s)
  assert.match(result, /\.callout-caution[^}]+#fd7e14/s)
  assert.match(result, /\.callout-important[^}]+#dc3545/s)
})

test('updates an older installed palette', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-classroom-visual-css-update-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const editor = path.join(root, 'assets', 'www', 'editor')
  fs.mkdirSync(editor, { recursive: true })
  const stylesheet = path.join(editor, 'style.css')
  fs.writeFileSync(stylesheet, `.ProseMirror{}\n${marker}\n.old-rule { color: red; }`)

  assert.equal(install(root), true)
  const result = fs.readFileSync(stylesheet, 'utf8')
  assert.doesNotMatch(result, /old-rule/)
  assert.match(result, /\.callout-tip[^}]+#198754/s)
})
