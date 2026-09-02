#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const env = { ...process.env, TLDA_ENV: process.env.TLDA_ENV || 'testing' }
if (env.TLDA_ENV !== 'testing') throw new Error('this destructive integration gate only runs with TLDA_ENV=testing')

const deadlineMs = Number(process.env.TLDA_SYNC_GATE_DEADLINE_MS || 60_000)
const root = mkdtempSync(join(tmpdir(), 'tlda-interleaved-sync-'))
const name = `interleaved-sync-${Date.now()}`
const source = join(root, 'main.md')
const transitions = []
let linked = false
let browser = false

function run(file, args, options = {}) {
  return execFileSync(file, args, { cwd: options.cwd || root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function git(...args) { return run('git', args).trim() }
function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function browserCode(body) {
  const output = run('tlda-dev', ['pw', 'run-code', body], { cwd: process.cwd() })
  const match = output.match(/TLDA_SYNC_STATE:([A-Za-z0-9+/=]+)/)
  return match ? JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) : output
}

function encodeBrowserResult(expression) {
  return `(async page => { const value = await (${expression}); const encoded = await page.evaluate(value => btoa(unescape(encodeURIComponent(JSON.stringify(value)))), value); return 'TLDA_SYNC_STATE:' + encoded })`
}

function browserState() {
  return browserCode(encodeBrowserResult(`page.evaluate(async project => {
    const statusResponse = await fetch('/api/projects/' + encodeURIComponent(project) + '/build/status')
    const status = await statusResponse.json()
    const sourceResponse = await fetch('/api/projects/' + encodeURIComponent(project) + '/source/main.md')
    const sourceText = await sourceResponse.text()
    const sentinel = window.__tldraw_editor__?.store?.get('shape:doc-version--sentinel')
    const rendered = Array.from(document.querySelectorAll('iframe')).map(frame => frame.contentDocument?.body?.innerText || '').join('\\n')
    return {
      status: status.status,
      sourceRevision: status.sourceRevision,
      acceptSeq: status.acceptSeq,
      acceptedRevision: sourceResponse.headers.get('X-TLDA-Source-Revision'),
      sourceText,
      servedRevision: sentinel?.props?.sourceRevision || null,
      servedAcceptSeq: sentinel?.props?.acceptSeq || null,
      rendered,
    }
  }, ${JSON.stringify(name)})`))
}

async function waitFor(label, expectedText, previousSeq) {
  const started = Date.now()
  let last
  while (Date.now() - started < deadlineMs) {
    last = browserState()
    const ordered = Number(last.acceptSeq) > Number(previousSeq)
    const sameRevision = last.sourceRevision &&
      last.sourceRevision === last.acceptedRevision &&
      last.sourceRevision === last.servedRevision
    const visibleExpected = expectedText.replace(/\s+/g, ' ').trim()
    const visibleRendered = last.rendered.replace(/\s+/g, ' ').trim()
    if (last.status === 'success' && ordered && sameRevision &&
        last.sourceText === expectedText && visibleRendered.includes(visibleExpected)) {
      const transition = { label, elapsedMs: Date.now() - started, ...last }
      transitions.push(transition)
      console.log(JSON.stringify(transition))
      return transition
    }
    await pause(750)
  }
  throw new Error(`${label} did not reach watcher → accepted → build → served: ${JSON.stringify(last)}`)
}

function createEditor() {
  browserCode(`async page => {
    await page.evaluate(() => {
      const editor = window.__tldraw_editor__
      const owned = editor.getCurrentPageShapes().find(shape => shape.type.startsWith('fleet-') && shape.props.userId && shape.props.deviceId)
      if (!owned) throw new Error('no browser-owned fleet panel found')
      const id = 'shape:interleaved-sync-source-editor'
      if (!editor.getShape(id)) editor.createShape({
        id, type: 'fleet-source-editor', x: 100, y: 100,
        props: { w: 700, h: 500, file: 'main.md', line: 1, title: 'main.md', userId: owned.props.userId, deviceId: owned.props.deviceId },
      })
      editor.zoomToFit()
    })
    await page.locator('.fleet-source-editor .cm-content').waitFor({ state: 'visible' })
  }`)
}

function browserEdit(text) {
  browserCode(`async page => {
    const editor = page.locator('.fleet-source-editor .cm-content')
    await editor.fill(${JSON.stringify(text)})
    await page.keyboard.press('Meta+s')
  }`)
}

async function main() {
  run('git', ['init', '-q', '-b', 'main'])
  git('config', 'user.name', 'interleaved-sync-gate')
  git('config', 'user.email', 'interleaved-sync-gate@example.invalid')
  writeFileSync(source, 'BASE\n')
  git('add', 'main.md')
  git('commit', '-qm', 'Base')
  run('tlda', ['project', 'link', name, 'main.md', '--format', 'markdown'])
  linked = true

  run('tlda-dev', ['pw', 'acquire'], { cwd: process.cwd() })
  browser = true
  run('tlda-dev', ['pw', 'setup', '--project', name], { cwd: process.cwd() })
  createEditor()

  const baseline = await waitFor('baseline', 'BASE\n', -1)
  let text = 'BASE\nAGENT-1\n'
  writeFileSync(source, text)
  let state = await waitFor('agent-1', text, baseline.acceptSeq)

  text += 'BROWSER-1\n'
  browserEdit(text)
  state = await waitFor('browser-1', text, state.acceptSeq)

  text += 'AGENT-2\n'
  writeFileSync(source, text)
  state = await waitFor('agent-2', text, state.acceptSeq)

  text += 'BROWSER-2\n'
  browserEdit(text)
  state = await waitFor('browser-2', text, state.acceptSeq)

  const mergeOutput = run('tlda', ['project', 'merge', name, '--into', 'main', '--repo', root, '--ff-only'])
  if (!/Landed \d+ commit\(s\) on main/.test(mergeOutput)) throw new Error(`merge did not land: ${mergeOutput}`)
  if (git('show', 'main:main.md') + '\n' !== text) throw new Error('merged main.md does not contain the ordered interleaved edits')
  if (readFileSync(source, 'utf8') !== text) throw new Error('working-tree content changed during merge-back')
  console.log(mergeOutput.trim())
  console.log(`PASS ${transitions.length} ordered accepted/build/served revisions and installed-CLI merge-back`)
}

try {
  await main()
} finally {
  if (linked) spawnSync('tlda', ['project', 'delete', name], { cwd: root, env, encoding: 'utf8' })
  if (browser) spawnSync('tlda-dev', ['pw', 'release'], { cwd: process.cwd(), env, encoding: 'utf8' })
  const trash = join(homedir(), '.Trash', basename(root))
  if (existsSync(root) && !existsSync(trash)) renameSync(root, trash)
}
