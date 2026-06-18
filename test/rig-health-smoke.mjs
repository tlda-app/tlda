#!/usr/bin/env node

import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import '../shared/config.mjs'
import { resolveRigEnv } from './rig-env.mjs'

const DEFAULT_RENDER_DOC = 'rig-render-smoke-doc'
const DEFAULT_RENDER_TEXT = 'TLDA render smoke visible content'
const DEFAULT_TIMEOUT_MS = 60000
const MINIMAL_TEX = String.raw`\documentclass{article}
\begin{document}
TLDA render smoke visible content
\end{document}
`

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const [key, ...value] = arg.slice(2).split('=')
    args[key] = value.length ? value.join('=') : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true)
  }
  return args
}

function boolArg(value) {
  return value === true || value === '1' || value === 'true' || value === 'yes'
}

function isUsableUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function configToken() {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.config', 'tlda', 'config.json'), 'utf8'))
    return cfg.tokenRw || cfg.token || ''
  } catch {
    return ''
  }
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function withToken(url, token) {
  const u = new URL(url)
  if (token && !u.searchParams.has('token')) u.searchParams.set('token', token)
  return u.toString()
}

function projectUrl(base, path, token) {
  const u = new URL(path, `${base.replace(/\/+$/, '')}/`)
  if (token) u.searchParams.set('token', token)
  return u.toString()
}

export function checkRigHealth(options = {}) {
  let env
  const problems = []

  try {
    env = resolveRigEnv(options)
  } catch (e) {
    return {
      ok: false,
      problems: [`rig manifest could not be read: ${e.message}`],
      env: {
        manifestPath: null,
        manifest: null,
        viewer: null,
        doc: options.doc || 'bregman',
        noAuth: false,
      },
    }
  }

  if (!env.manifestPath) problems.push('no rig manifest was found')
  if (!env.manifest || typeof env.manifest !== 'object') {
    problems.push('rig manifest is not a JSON object')
  }
  if (!isUsableUrl(env.viewer)) {
    problems.push('rig manifest must provide an http(s) viewer URL')
  }
  if (!options.doc && (typeof env.manifest?.doc !== 'string' || !env.manifest.doc.trim())) {
    problems.push('rig manifest must provide a non-empty doc')
  }
  if (typeof env.manifest?.noAuth !== 'boolean') {
    problems.push('rig manifest must provide boolean noAuth')
  }

  return {
    ok: problems.length === 0,
    problems,
    env,
  }
}

export function inspectRenderSnapshot(snapshot) {
  const problems = []

  if (!snapshot.rootText && snapshot.rootChildCount === 0) {
    problems.push('root is blank')
  }
  if (snapshot.errorScreen) {
    problems.push(`error screen visible: ${snapshot.errorText || '(no error text)'}`)
  }
  if (snapshot.loadingScreen) {
    problems.push(`still loading: ${snapshot.loadingText || '(no loading text)'}`)
  }
  if (!snapshot.editorReady) {
    problems.push('tldraw editor never became ready')
  }
  if (snapshot.pageShapeCount < 1) {
    problems.push('no document page shapes rendered')
  }
  if (snapshot.svgElementCount < 1) {
    problems.push('no svg elements rendered inside document page shapes')
  }
  if (snapshot.visibleTextCount < 1) {
    problems.push('no visible SVG text rendered')
  }

  return {
    ok: problems.length === 0,
    problems,
  }
}

async function apiJson(url, { method = 'GET', token = '', body = null } = {}) {
  const target = projectUrl(url.origin, url.pathname + url.search, token)
  let res
  try {
    res = await fetch(target, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(token),
      },
      body: body ? JSON.stringify(body) : null,
    })
  } catch (e) {
    throw new Error(`${method} ${target} failed: ${e.message}`)
  }
  let data = null
  try {
    data = await res.json()
  } catch (e) {
    data = { parseError: e.message }
  }
  return { res, data }
}

async function ensureSmokeDoc(base, doc, token) {
  const createUrl = new URL('/api/projects', base)
  const create = await apiJson(createUrl, {
    method: 'POST',
    token,
    body: { name: doc, title: doc, mainFile: 'test.tex' },
  })
  if (!create.res.ok && create.res.status !== 409) {
    throw new Error(`create smoke project failed (${create.res.status}): ${JSON.stringify(create.data)}`)
  }

  const pushUrl = new URL(`/api/projects/${encodeURIComponent(doc)}/push`, base)
  const push = await apiJson(pushUrl, {
    method: 'POST',
    token,
    body: { files: [{ path: 'test.tex', content: MINIMAL_TEX }] },
  })
  if (!push.res.ok) {
    throw new Error(`push smoke project failed (${push.res.status}): ${JSON.stringify(push.data)}`)
  }

  const buildUrl = new URL(`/api/projects/${encodeURIComponent(doc)}/build`, base)
  const build = await apiJson(buildUrl, {
    method: 'POST',
    token,
    body: {},
  })
  if (!build.res.ok) {
    throw new Error(`trigger smoke project build failed (${build.res.status}): ${JSON.stringify(build.data)}`)
  }
}

async function waitForBuild(base, doc, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const statusUrl = new URL(`/api/projects/${encodeURIComponent(doc)}/build/status`, base)
    const { res, data } = await apiJson(statusUrl, { token })
    if (!res.ok) throw new Error(`build status failed (${res.status}): ${JSON.stringify(data)}`)
    last = data
    if (data?.status && data.status !== 'building') {
      if (data.status !== 'success') {
        throw new Error(`smoke doc build ended with status=${data.status}: ${(data.log || '').slice(-1000)}`)
      }
      return data
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`smoke doc build did not finish within ${timeoutMs}ms; last=${JSON.stringify(last)}`)
}

function renderSnapshotScript(expectedText) {
  return (text) => {
    const root = document.getElementById('root')
    const rootText = (root?.innerText || root?.textContent || '').trim()
    const pageShapeSelector = '[data-shape-type="svg-page"], [data-shape-type="html-page"]'
    const pageShapes = Array.from(document.querySelectorAll(pageShapeSelector))
    const svgs = Array.from(document.querySelectorAll('[data-shape-type="svg-page"] svg'))
    const svgTexts = svgs.flatMap(svg =>
      Array.from(svg.querySelectorAll('text, tspan'))
        .map(el => (el.textContent || '').trim())
        .filter(Boolean))
    return {
      url: window.location.href,
      rootChildCount: root?.children?.length || 0,
      rootText,
      errorScreen: !!document.querySelector('.ErrorScreen'),
      errorText: (document.querySelector('.ErrorScreen')?.textContent || '').trim(),
      loadingScreen: !!document.querySelector('.LoadingScreen'),
      loadingText: (document.querySelector('.LoadingScreen')?.textContent || '').trim(),
      editorReady: !!window.__tldraw_editor__,
      pageShapeCount: pageShapes.length,
      svgElementCount: svgs.length,
      visibleTextCount: svgTexts.length,
      renderedText: svgTexts.join(' '),
      expectedTextFound: text ? svgTexts.join(' ').includes(text) : true,
    }
  }
}

export async function checkRigRender(options = {}) {
  const doc = options.doc || DEFAULT_RENDER_DOC
  const health = checkRigHealth({ ...options, doc })
  if (!health.ok) return { ...health, render: null }

  const env = health.env
  const viewer = options.url || env.viewer
  const backend = options.backend || env.backend || viewer
  const token = env.noAuth ? '' : (options.token || env.token || configToken())
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)
  const expectedText = options.expectedText || DEFAULT_RENDER_TEXT
  const createDoc = options.createDoc !== false
  const problems = []
  const consoleMessages = []
  const httpErrors = []
  let browser

  try {
    if (createDoc) {
      await ensureSmokeDoc(backend, doc, token)
      await waitForBuild(backend, doc, token, timeoutMs)
    }

    const { chromium } = await import('playwright')
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const loc = msg.location()
        const at = loc.url ? ` at ${loc.url}${loc.lineNumber ? `:${loc.lineNumber}` : ''}` : ''
        consoleMessages.push(`console.error: ${msg.text()}${at}`)
      }
    })
    page.on('pageerror', err => consoleMessages.push(`pageerror: ${err.message}`))
    page.on('requestfailed', req => {
      const failure = req.failure()?.errorText || 'request failed'
      const url = req.url()
      if (!url.startsWith('data:')) consoleMessages.push(`requestfailed: ${url} (${failure})`)
    })
    page.on('response', res => {
      if (res.status() >= 400) httpErrors.push(`http ${res.status()}: ${res.url()}`)
    })

    const target = withToken(`${viewer.replace(/\/+$/, '')}/?doc=${encodeURIComponent(doc)}&pw=1`, token)
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs })

    await page.waitForFunction((text) => {
      const root = document.getElementById('root')
      const rootText = (root?.innerText || root?.textContent || '').trim()
      const pageShapes = document.querySelectorAll('[data-shape-type="svg-page"], [data-shape-type="html-page"]')
      const svgs = Array.from(document.querySelectorAll('[data-shape-type="svg-page"] svg'))
      const svgText = svgs.flatMap(svg =>
        Array.from(svg.querySelectorAll('text, tspan'))
          .map(el => (el.textContent || '').trim())
          .filter(Boolean))
        .join(' ')
      return !!rootText &&
        !document.querySelector('.ErrorScreen') &&
        !document.querySelector('.LoadingScreen') &&
        !!window.__tldraw_editor__ &&
        pageShapes.length > 0 &&
        svgs.length > 0 &&
        svgText.length > 0 &&
        (!text || svgText.includes(text))
    }, expectedText, {
      timeout: timeoutMs,
      polling: 500,
    }).catch(() => {})
    await page.waitForTimeout(750)

    const snapshot = await page.evaluate(renderSnapshotScript(expectedText), expectedText)
    const inspected = inspectRenderSnapshot(snapshot)
    problems.push(...inspected.problems)
    if (!snapshot.expectedTextFound) {
      problems.push(`expected smoke text not found in rendered SVG text: "${expectedText}"`)
    }
    if (consoleMessages.length > 0) {
      problems.push(...consoleMessages.map(message => `browser ${message}`))
    }
    if (httpErrors.length > 0) {
      problems.push(...httpErrors.map(message => `browser ${message}`))
    }

    return {
      ok: problems.length === 0,
      problems,
      env,
      render: {
        doc,
        viewer,
        backend,
        url: snapshot.url,
        snapshot,
        consoleMessages,
        httpErrors,
      },
    }
  } catch (e) {
    return {
      ok: false,
      problems: [`render smoke failed: ${e.message}`],
      env,
      render: { doc, viewer, backend, consoleMessages, httpErrors },
    }
  } finally {
    if (browser) await browser.close()
  }
}

export function runRigHealthSmoke(argv = process.argv.slice(2), io = console) {
  const args = parseArgs(argv)
  const options = {
    rig: args.rig,
    doc: args.doc,
    url: args.url,
    backend: args.backend,
    token: args.token,
    timeoutMs: args.timeout,
    createDoc: !boolArg(args['no-create']),
  }
  const result = boolArg(args.render)
    ? checkRigRender(options)
    : checkRigHealth(options)

  if (result && typeof result.then === 'function') {
    return result.then(renderResult => printRigHealthResult(renderResult, io, true))
  }

  return printRigHealthResult(result, io, false)
}

function printRigHealthResult(result, io, rendered) {
  if (result.ok) {
    const render = rendered && result.render ? `  rendered=${result.render.url}` : ''
    io.log(`rig-health-smoke PASS  doc=${result.render?.doc || result.env.doc}  viewer=${result.env.viewer}  noAuth=${result.env.noAuth}  rig=${result.env.manifestPath}${render}`)
    return 0
  }

  io.error('rig-health-smoke FAIL')
  for (const problem of result.problems) io.error(`  - ${problem}`)
  if (result.env.manifestPath) io.error(`  rig=${result.env.manifestPath}`)
  if (result.render?.url) io.error(`  rendered=${result.render.url}`)
  return 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = runRigHealthSmoke()
  if (result && typeof result.then === 'function') {
    result.then(code => process.exit(code)).catch(e => {
      console.error('rig-health-smoke crashed:', e)
      process.exit(2)
    })
  } else {
    process.exit(result)
  }
}
