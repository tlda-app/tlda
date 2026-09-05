#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : true
}

function die(message) {
  throw new Error(message)
}

function writeFixture(target) {
  const parts = join(target, 'parts')
  mkdirSync(parts, { recursive: true })
  writeFileSync(join(target, 'main.tex'), String.raw`\documentclass{article}
\begin{document}
\newcount\benchmarkpage
\benchmarkpage=0
\loop
  Whole-system source benchmark page \the\benchmarkpage.\par
  Main marker: BENCH-main-0.\par
  \input{parts/a.tex}\par
  \input{parts/b.tex}\par
  \input{parts/shared.tex}\par
  \vfill\newpage
  \advance\benchmarkpage by 1
\ifnum\benchmarkpage<120
\repeat
\end{document}
`)
  writeFileSync(join(parts, 'a.tex'), 'Dependency A marker: BENCH-a-0.\n')
  writeFileSync(join(parts, 'b.tex'), 'Dependency B marker: BENCH-b-0.\n')
  writeFileSync(join(parts, 'shared.tex'), 'Shared dependency marker: BENCH-shared-0.\n')
  console.log(target)
}

async function projectState(base, project, token) {
  const response = await fetch(`${base}/api/projects/${encodeURIComponent(project)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) die(`project state returned HTTP ${response.status}`)
  const state = await response.json()
  return {
    observedAt: Date.now(),
    buildStatus: state.buildStatus ?? null,
    buildPhase: state.buildPhase ?? null,
    lastBuild: state.lastBuild ?? null,
    sourceRevision: state.sourceRevision ?? null,
    acceptSeq: state.acceptSeq ?? null,
    pages: state.pages ?? null,
  }
}

async function browserState() {
  const expression = `() => {
    const editor = window.__tldraw_editor__
    const version = editor && [...editor.getCurrentPageShapeIds()]
      .map(id => editor.getShape(id)).find(shape => shape?.type === 'doc-version')
    const renderedPages = [...document.querySelectorAll(
      '[data-shape-type="svg-page"]:not(.tl-shape-background) .svg-page-content'
    )].filter(page => !page.closest('.fleet-hud-wrap'))
      .map(page => page.innerHTML).sort()
    let renderedFingerprint = 2166136261
    for (const page of renderedPages) {
      for (let index = 0; index < page.length; index++) {
        renderedFingerprint ^= page.charCodeAt(index)
        renderedFingerprint = Math.imul(renderedFingerprint, 16777619)
      }
    }
    return {
      project: new URL(location.href).searchParams.get('project'),
      ready: !!editor,
      renderedPageCount: renderedPages.length,
      renderedFingerprint: renderedPages.length
        ? (renderedFingerprint >>> 0).toString(16).padStart(8, '0')
        : null,
      sourceRevision: version?.props?.sourceRevision ?? null,
      acceptSeq: version?.props?.acceptSeq ?? null,
      errorsJson: version?.props?.errorsJson ?? null,
      warningsJson: version?.props?.warningsJson ?? null,
    }
  }`
  const timeout = Number(arg('browser-timeout-ms', '60000'))
  const deadline = Date.now() + timeout
  let stdout
  while (true) {
    try {
      ({ stdout } = await execFileAsync('tlda-dev', ['pw', 'eval', expression], {
        encoding: 'utf8', timeout,
      }))
      break
    } catch (error) {
      if (!String(error).includes('pw busy') || Date.now() >= deadline) throw error
      await sleep(250)
    }
  }
  const match = stdout.match(/### Result\s*\n([\s\S]*?)\n### Ran/)
  if (!match) die('could not parse pooled-browser result')
  return { observedAt: Date.now(), ...JSON.parse(match[1]) }
}

function editMarker(drive, slot, from, to, replacement = null) {
  const relativeFile = slot === 'main' ? 'main.tex' : `parts/${slot}.tex`
  const file = resolve(drive, relativeFile)
  const current = readFileSync(file, 'utf8')
  const oldMarker = `BENCH-${slot}-${from}`
  if (!current.includes(oldMarker)) die(`${relativeFile} does not contain ${oldMarker}`)
  const nextMarker = replacement ?? `BENCH-${slot}-${to}`
  writeFileSync(file, current.replace(oldMarker, () => nextMarker))
  return relativeFile
}

function makeObserver({ base, project, token, pollMs }) {
  const transitions = {
    acceptance: [], buildStart: [], buildCompletion: [], browserRevision: [], browser: [],
    browserVisibility: [],
  }
  let latestServer = null
  let latestBrowser = null
  let running = false
  let loopPromises = []
  let loopError = null
  let stableRenderedSamples = 0
  let latestRenderedChange = null

  async function sampleServer() {
    const server = await projectState(base, project, token)
    if (latestServer) {
      if (server.acceptSeq !== latestServer.acceptSeq) {
        transitions.acceptance.push({
          at: server.observedAt,
          fromAcceptSeq: latestServer.acceptSeq,
          acceptSeq: server.acceptSeq,
          sourceRevision: server.sourceRevision,
        })
      }
      const wasBuilding = latestServer.buildStatus === 'building'
      const isBuilding = server.buildStatus === 'building'
      if (!wasBuilding && isBuilding) {
        transitions.buildStart.push({
          at: server.observedAt,
          acceptSeq: server.acceptSeq,
          sourceRevision: server.sourceRevision,
        })
      }
      const successfulCompletion = server.buildStatus === 'success'
        && server.lastBuild !== latestServer.lastBuild
      const failedCompletion = server.buildStatus === 'error' && wasBuilding
      if (successfulCompletion || failedCompletion) {
        transitions.buildCompletion.push({
          at: server.observedAt,
          status: server.buildStatus,
          lastBuild: server.lastBuild,
          acceptSeq: server.acceptSeq,
          sourceRevision: server.sourceRevision,
        })
      }
    }
    latestServer = server
  }

  async function sampleBrowser() {
    const browser = await browserState()
    if (browser.project !== project || !browser.ready) {
      die(`pooled browser is not ready on disposable project ${project}`)
    }
    if (latestBrowser && browser.sourceRevision !== latestBrowser.sourceRevision) {
      transitions.browserRevision.push({
        at: browser.observedAt,
        acceptSeq: browser.acceptSeq,
        sourceRevision: browser.sourceRevision,
        errorsJson: browser.errorsJson,
        warningsJson: browser.warningsJson,
      })
    }
    if (latestBrowser
      && browser.renderedFingerprint
      && browser.renderedFingerprint !== latestBrowser.renderedFingerprint) {
      latestRenderedChange = {
        at: browser.observedAt,
        acceptSeq: browser.acceptSeq,
        sourceRevision: browser.sourceRevision,
        renderedPageCount: browser.renderedPageCount,
        fromRenderedFingerprint: latestBrowser.renderedFingerprint,
        renderedFingerprint: browser.renderedFingerprint,
        errorsJson: browser.errorsJson,
        warningsJson: browser.warningsJson,
      }
      transitions.browser.push(latestRenderedChange)
      stableRenderedSamples = 0
    } else if (latestBrowser && browser.renderedFingerprint) {
      stableRenderedSamples++
    }
    const alreadySettled = transitions.browserVisibility.at(-1)
    if (latestRenderedChange
      && stableRenderedSamples >= 1
      && browser.sourceRevision === latestRenderedChange.sourceRevision
      && (alreadySettled?.sourceRevision !== browser.sourceRevision
        || alreadySettled?.renderedFingerprint !== browser.renderedFingerprint)) {
      transitions.browserVisibility.push({
        ...latestRenderedChange,
        settledAt: browser.observedAt,
      })
    }
    latestBrowser = browser
  }

  async function start() {
    await Promise.all([sampleServer(), sampleBrowser()])
    running = true
    const runLoop = (sample, delay) => (async () => {
      while (running) {
        await sleep(delay)
        try {
          await sample()
        } catch (error) {
          loopError = error
          running = false
        }
      }
    })()
    loopPromises = [runLoop(sampleServer, pollMs), runLoop(sampleBrowser, 0)]
  }

  async function stop() {
    running = false
    await Promise.all(loopPromises)
  }

  return {
    transitions,
    start,
    stop,
    server: () => latestServer,
    browser: () => latestBrowser,
    error: () => loopError,
  }
}

async function waitFor(description, predicate, timeoutMs, observer) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (observer.error()) throw observer.error()
    if (Date.now() - startedAt > timeoutMs) die(`timed out waiting for ${description}`)
    await sleep(50)
  }
  return predicate()
}

function acceptanceAfter(observer, at) {
  return observer.transitions.acceptance.find(item => item.at >= at)
}

function completionFor(observer, revision) {
  return observer.transitions.buildCompletion.find(item => item.sourceRevision === revision)
}

function browserFor(observer, revision) {
  return observer.transitions.browserVisibility.find(item => item.sourceRevision === revision)
}

async function applyOperation({ observer, operations, drive, slot, counters, replacement = null }) {
  const from = counters[slot]
  const to = from + 1
  const operation = {
    id: `source-${operations.length + 1}`,
    slot,
    file: editMarker(drive, slot, from, to, replacement),
    appliedAt: Date.now(),
  }
  counters[slot] = to
  operations.push(operation)
  return operation
}

async function runPattern() {
  const pattern = arg('pattern') || die('run needs --pattern spaced|multi-file|during-build')
  const drive = arg('drive') || die('run needs --drive DIR')
  const project = arg('project') || die('run needs --project DISPOSABLE')
  const base = arg('base', 'https://tlda-fly.cormorant-matrix.ts.net')
  const token = process.env.TLDA_TOKEN || die('run needs TLDA_TOKEN')
  const load = Number(arg('load', '1'))
  const breakBuild = process.argv.includes('--break-build')
  const pollMs = Number(arg('poll-ms', '250'))
  const timeoutMs = Number(arg('timeout-ms', '300000'))
  const output = arg('output') || join('scratch', 'benchmarks',
    `source-${pattern}-load-${load}-${Date.now()}.json`)
  if (!['spaced', 'multi-file', 'during-build'].includes(pattern)) die(`unknown pattern ${pattern}`)
  if (!Number.isInteger(load) || load < 1) die('--load must be a positive integer')

  const observer = makeObserver({ base, project, token, pollMs })
  const operations = []
  const counters = { main: 0, a: 0, b: 0, shared: 0 }
  const startedAt = Date.now()
  let runError = null
  let baseline = null

  try {
    await observer.start()
    if (observer.server().buildStatus !== 'success') die('baseline build is not successful')
    if (observer.server().sourceRevision !== observer.browser().sourceRevision) {
      die('baseline server and browser source revisions differ')
    }
    baseline = { server: observer.server(), browser: observer.browser() }

    if (pattern === 'spaced') {
      const slots = ['main', 'a', 'b']
      for (let cycle = 0; cycle < load; cycle++) {
        for (const slot of slots) {
          const replacement = breakBuild && operations.length === 0
            ? String.raw`\undefinedBenchmarkControlSequence`
            : null
          const operation = await applyOperation({
            observer, operations, drive, slot, counters, replacement,
          })
          const accepted = await waitFor('source acceptance',
            () => acceptanceAfter(observer, operation.appliedAt), timeoutMs, observer)
          const completed = await waitFor('build completion',
            () => completionFor(observer, accepted.sourceRevision), timeoutMs, observer)
          if (completed.status !== 'success') die(`build ended ${completed.status}`)
          await waitFor('same-open-browser visibility',
            () => browserFor(observer, accepted.sourceRevision), timeoutMs, observer)
        }
      }
    } else if (pattern === 'multi-file') {
      const slots = ['main', 'a', 'b', 'shared']
      for (let cycle = 0; cycle < load; cycle++) {
        for (const slot of slots) {
          await applyOperation({ observer, operations, drive, slot, counters })
        }
      }
      const last = operations.at(-1)
      const accepted = await waitFor('multi-file source acceptance',
        () => acceptanceAfter(observer, last.appliedAt), timeoutMs, observer)
      const completed = await waitFor('multi-file build completion',
        () => completionFor(observer, accepted.sourceRevision), timeoutMs, observer)
      if (completed.status !== 'success') die(`build ended ${completed.status}`)
      await waitFor('multi-file same-open-browser visibility',
        () => browserFor(observer, accepted.sourceRevision), timeoutMs, observer)
    } else {
      const trigger = await applyOperation({ observer, operations, drive, slot: 'main', counters })
      await waitFor('trigger source acceptance',
        () => acceptanceAfter(observer, trigger.appliedAt), timeoutMs, observer)
      await waitFor('active build', () => observer.server().buildStatus === 'building', timeoutMs, observer)
      const slots = ['a', 'b', 'shared']
      for (let index = 0; index < load; index++) {
        await applyOperation({ observer, operations, drive, slot: slots[index % slots.length], counters })
      }
      const last = operations.at(-1)
      const accepted = await waitFor('during-build source acceptance',
        () => acceptanceAfter(observer, last.appliedAt), timeoutMs, observer)
      const completed = await waitFor('during-build final completion',
        () => completionFor(observer, accepted.sourceRevision), timeoutMs, observer)
      if (completed.status !== 'success') die(`build ended ${completed.status}`)
      await waitFor('during-build same-open-browser visibility',
        () => browserFor(observer, accepted.sourceRevision), timeoutMs, observer)
    }
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error)
  } finally {
    if (observer.server()) await observer.stop()
  }

  for (const operation of operations) {
    const accepted = acceptanceAfter(observer, operation.appliedAt) || null
    const completed = accepted ? completionFor(observer, accepted.sourceRevision) || null : null
    const visible = accepted ? browserFor(observer, accepted.sourceRevision) || null : null
    operation.acceptance = accepted && {
      transitionAcceptSeq: accepted.acceptSeq,
      sourceRevision: accepted.sourceRevision,
      latencyMs: accepted.at - operation.appliedAt,
    }
    operation.buildCompletion = completed && {
      status: completed.status,
      sourceRevision: completed.sourceRevision,
      latencyFromAcceptanceMs: completed.at - accepted.at,
      latencyFromEditMs: completed.at - operation.appliedAt,
    }
    operation.browserVisibility = visible && {
      sourceRevision: visible.sourceRevision,
      renderedFingerprint: visible.renderedFingerprint,
      confirmedAt: visible.settledAt,
      latencyFromBuildMs: completed ? visible.at - completed.at : null,
      latencyFromEditMs: visible.at - operation.appliedAt,
      confirmationLatencyFromEditMs: visible.settledAt - operation.appliedAt,
    }
  }

  for (const transition of observer.transitions.acceptance) {
    transition.operationIds = operations
      .filter(operation => operation.acceptance?.transitionAcceptSeq === transition.acceptSeq)
      .map(operation => operation.id)
  }
  for (const transition of observer.transitions.buildCompletion) {
    transition.operationIds = operations
      .filter(operation => operation.acceptance?.sourceRevision === transition.sourceRevision)
      .map(operation => operation.id)
  }
  for (const transition of observer.transitions.browser) {
    transition.operationIds = operations
      .filter(operation => operation.acceptance?.sourceRevision === transition.sourceRevision)
      .map(operation => operation.id)
  }
  for (const transition of observer.transitions.browserVisibility) {
    transition.operationIds = operations
      .filter(operation => operation.acceptance?.sourceRevision === transition.sourceRevision)
      .map(operation => operation.id)
  }

  const result = {
    pattern,
    load,
    breakBuild,
    project,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    error: runError,
    baseline,
    operations,
    transitions: observer.transitions,
  }
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  console.log(`wrote ${output}`)
  if (runError) process.exitCode = 1
}

const command = process.argv[2]
try {
  if (command === 'fixture') {
    writeFixture(resolve(arg('dir') || die('fixture needs --dir DIR')))
  } else if (command === 'run') {
    await runPattern()
  } else {
    console.log(`benchmark-source-patterns

  fixture --dir DIR
  run --pattern spaced|multi-file|during-build --drive DIR --project NAME
      [--load N] [--break-build] [--base URL] [--poll-ms N]
      [--timeout-ms N] [--output FILE]

The pooled browser must already be open on the disposable project.`)
  }
} catch (error) {
  console.error(`benchmark-source-patterns: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
}
