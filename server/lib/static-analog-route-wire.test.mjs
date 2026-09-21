// The static analog of a page, over a real socket against a real server.
//
// This exists because the app breaks: "I designed for the app to break. Cause
// all the evidence is that it does break." So the thing under test is not only
// that `/static/<project>/<source>.qmd` resolves — it is that it resolves
// WITHOUT the canvas. Nothing here opens a room, a viewer, or a sync socket;
// the fixture is a projects directory and a page-info.json, which is all the
// route is allowed to need.
//
// The redirect target matters as much as the status. A rendered page names its
// assets relative to its own directory, so a `/static/` prefix that served the
// bytes itself would break every stylesheet on the page it is supposed to be
// rescuing. Asserting the Location header is asserting that.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:https'
import test from 'node:test'

import { removeTempDir } from './test-support/remove-temp-dir.mjs'

const PROJECT = 'static-analog-fixture'
const CHAPTER_SOURCE = 'lectures/chapter-sampling-with-replacement.qmd'
const CHAPTER_RENDERED = '_book/lectures/chapter-sampling-with-replacement.html'
const INDEX_RENDERED = '_book/index.html'

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForServer(child) {
  let output = ''
  child.stdout.on('data', c => { output += c })
  child.stderr.on('data', c => { output += c })
  const deadline = Date.now() + 90_000
  while (!output.includes('Unified server running')) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`)
    await new Promise(r => setTimeout(r, 25))
  }
}

// Deliberately does NOT follow the redirect: the Location header is the claim.
function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', rejectUnauthorized: false },
      res => {
        let body = ''
        res.on('data', c => { body += c })
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function seedProject(projectsDir, name, pageInfo) {
  const output = join(projectsDir, name, 'output')
  mkdirSync(output, { recursive: true })
  if (pageInfo) writeFileSync(join(output, 'page-info.json'), JSON.stringify(pageInfo, null, 2))
  return output
}

async function withServer(seed, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-static-analog-'))
  const projectsDir = join(dir, 'projects')
  mkdirSync(projectsDir, { recursive: true })
  seed(projectsDir)
  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), PROJECTS_DIR: projectsDir,
      TLDA_FLEET_DB: join(dir, 'fleet.db'), TLDA_DEV_SERVER: '1',
      TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await waitForServer(child)
    await fn(port)
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    removeTempDir(dir)
  }
}

const PAGE_INFO = [
  { file: INDEX_RENDERED, title: 'Front', format: 'qmd', source: { type: 'project-source', format: 'qmd', file: 'index.qmd' } },
  { file: CHAPTER_RENDERED, title: 'Sampling with Replacement', format: 'qmd', source: { type: 'project-source', format: 'qmd', file: CHAPTER_SOURCE } },
]

test('the source path an author names resolves to the page the build rendered', async () => {
  await withServer(
    projectsDir => seedProject(projectsDir, PROJECT, PAGE_INFO),
    async port => {
      const withExtension = await get(port, `/static/${PROJECT}/${CHAPTER_SOURCE}`)
      assert.equal(withExtension.status, 302, `expected a redirect, got ${withExtension.status}: ${withExtension.body.slice(0, 200)}`)
      assert.equal(withExtension.location, `/docs/${PROJECT}/_book/lectures/chapter-sampling-with-replacement.html`)

      // The extension is how he writes it; the stem is how a person types it
      // from memory with a dead app in the other window.
      const withoutExtension = await get(port, `/static/${PROJECT}/lectures/chapter-sampling-with-replacement`)
      assert.equal(withoutExtension.status, 302)
      assert.equal(withoutExtension.location, withExtension.location)
    },
  )
})

test('no source path gives the front door', async () => {
  await withServer(
    projectsDir => seedProject(projectsDir, PROJECT, PAGE_INFO),
    async port => {
      const res = await get(port, `/static/${PROJECT}`)
      assert.equal(res.status, 302, `got ${res.status}: ${res.body.slice(0, 200)}`)
      assert.equal(res.location, `/docs/${PROJECT}/_book/index.html`)
    },
  )
})

test('the published app path opens the TLDA shell, not the copied course HTML', async () => {
  await withServer(
    projectsDir => {
      const output = seedProject(projectsDir, PROJECT, PAGE_INFO)
      const appPage = join(output, 'app', 'book', 'chapters', 'chapter-sampling-with-replacement.html')
      mkdirSync(join(appPage, '..'), { recursive: true })
      writeFileSync(appPage, '<html><body>copied Quarto page</body></html>')
    },
    async port => {
      const res = await get(port, `/docs/${PROJECT}/app/book/chapters/chapter-sampling-with-replacement.html`)
      assert.equal(res.status, 200, `got ${res.status}: ${res.body.slice(0, 200)}`)
      assert.match(res.body, /<div id="root"><\/div>/)
      assert.doesNotMatch(res.body, /copied Quarto page/)
      assert.match(res.body, /window\.__TLDA_CONFIG__/)

      const iframe = await get(port, `/docs/${PROJECT}/app/book/chapters/chapter-sampling-with-replacement.html?_tldaShape=shape%3Apage`)
      assert.equal(iframe.status, 200)
      assert.match(iframe.body, /copied Quarto page/)
    },
  )
})

test('the static published page stays a direct page and offers its App route', async () => {
  const staticPageInfo = [{
    file: 'static/book/chapters/chapter-sampling-with-replacement.html',
    title: 'Sampling with Replacement',
    format: 'qmd',
    source: { type: 'project-source', format: 'qmd', file: CHAPTER_SOURCE },
  }]
  const built = '<html><head><title>Sampling</title></head><body><main>static course page</main></body></html>'
  await withServer(
    projectsDir => {
      const output = seedProject(projectsDir, PROJECT, staticPageInfo)
      writeFileSync(join(projectsDir, PROJECT, 'project.json'), JSON.stringify({
        name: PROJECT, title: PROJECT, mainFile: 'index.qmd', format: 'qmd', pages: 1, buildStatus: 'success',
      }))
      const page = join(output, staticPageInfo[0].file)
      mkdirSync(join(page, '..'), { recursive: true })
      writeFileSync(page, built)
    },
    async port => {
      const res = await get(port, `/docs/${PROJECT}/static/book/chapters/chapter-sampling-with-replacement.html`)
      assert.equal(res.status, 200)
      assert.match(res.body, /<main>static course page<\/main>/)
      assert.match(res.body, new RegExp(`class="presentation-mode-switch" href="/docs/${PROJECT}/app/book/chapters/chapter-sampling-with-replacement\\.html"[^>]*>App</a>`))
      assert.doesNotMatch(res.body, /_tldaShape|tlda-navigate/, 'the direct page must not receive the canvas bridge')
    },
  )
})

test('the static published deck goes out without the slides bridge', async () => {
  // Same gate, separate branch: a deck under `static/` must keep its native
  // Reveal behavior, not the canvas-driven bridge that disables it.
  const deckPageInfo = [{
    file: 'static/book/decks/chapter-bootstrap-slides.html',
    title: 'Bootstrap slides',
    format: 'qmd',
    source: { type: 'project-source', format: 'qmd', file: 'decks/chapter-bootstrap-slides.qmd' },
  }]
  const built = '<html><head><title>Slides</title></head><body><div class="reveal"><div class="slides"></div></div></body></html>'
  await withServer(
    projectsDir => {
      const output = seedProject(projectsDir, PROJECT, deckPageInfo)
      writeFileSync(join(projectsDir, PROJECT, 'project.json'), JSON.stringify({
        name: PROJECT, title: PROJECT, mainFile: 'decks/chapter-bootstrap-slides.qmd',
        format: 'qmd', renderedFormat: 'slides', pages: 1, buildStatus: 'success',
      }))
      const page = join(output, deckPageInfo[0].file)
      mkdirSync(join(page, '..'), { recursive: true })
      writeFileSync(page, built)
    },
    async port => {
      const res = await get(port, `/docs/${PROJECT}/static/book/decks/chapter-bootstrap-slides.html`)
      assert.equal(res.status, 200)
      assert.match(res.body, /<div class="reveal"><div class="slides"><\/div><\/div>/)
      assert.match(res.body, />App<\/a>/)
      assert.doesNotMatch(res.body, /_tldaShape|tlda-navigate/, 'a static deck must not receive the slides bridge')
    },
  )
})

test('a published course door reaches the static page, not the app shell', async () => {
  // A published course records every page as `app/book/…` in the top-level
  // page-info.json. `/docs/<project>/app/…` serves the TLDA reader shell by
  // design, so a `/static/` redirect that replays the recorded path verbatim
  // lands the reader on the shell — the door must rewrite to the `static/`
  // mirror, which is the same render from the same run.
  const publishedPageInfo = [
    { file: 'app/book/chapters/chapter-bootstrap.html', title: 'Bootstrap', format: 'qmd', source: { type: 'project-source', format: 'qmd', file: 'chapters/chapter-bootstrap.qmd' } },
    { file: 'app/book/decks/chapter-bootstrap-slides.html', title: 'Bootstrap slides', format: 'qmd', source: { type: 'project-source', format: 'qmd', file: 'decks/chapter-bootstrap-slides.qmd' } },
    { file: 'app/book/homework/homework-calibration-solutions.html', title: 'Calibration', format: 'qmd', source: { type: 'project-source', format: 'qmd', file: 'homework/homework-calibration.qmd' } },
  ]
  await withServer(
    projectsDir => seedProject(projectsDir, PROJECT, publishedPageInfo),
    async port => {
      for (const [source, page] of [
        ['chapters/chapter-bootstrap.qmd', 'static/book/chapters/chapter-bootstrap.html'],
        ['decks/chapter-bootstrap-slides.qmd', 'static/book/decks/chapter-bootstrap-slides.html'],
        ['homework/homework-calibration.qmd', 'static/book/homework/homework-calibration-solutions.html'],
      ]) {
        const res = await get(port, `/static/${PROJECT}/${source}`)
        assert.equal(res.status, 302, `expected a redirect, got ${res.status}: ${res.body.slice(0, 200)}`)
        assert.equal(res.location, `/docs/${PROJECT}/${page}`)
      }
      // The front door takes pageInfo[0], which is an app/ path here too.
      const front = await get(port, `/static/${PROJECT}`)
      assert.equal(front.status, 302)
      assert.equal(front.location, `/docs/${PROJECT}/static/book/chapters/chapter-bootstrap.html`)
    },
  )
})

// THE CONTROL. Every assertion above is a 302, and a route that redirected
// unconditionally would pass all of them. These two are the cases that must NOT
// redirect, and they are why the green above means something.
test('a page that was never rendered does not redirect, and says what there is', async () => {
  await withServer(
    projectsDir => seedProject(projectsDir, PROJECT, PAGE_INFO),
    async port => {
      const res = await get(port, `/static/${PROJECT}/lectures/chapter-that-does-not-exist.qmd`)
      assert.equal(res.status, 404, `a missing page must not redirect; got ${res.status} -> ${res.location}`)
      assert.match(res.body, /chapter-sampling-with-replacement\.qmd/,
        'the 404 must list what IS there — a typo should be self-correcting when the app is the broken half')
    },
  )
})

test('a project with no rendered output does not redirect', async () => {
  await withServer(
    projectsDir => seedProject(projectsDir, 'never-built', null),
    async port => {
      const res = await get(port, '/static/never-built/index.qmd')
      assert.equal(res.status, 404, `an unbuilt project must not redirect; got ${res.status} -> ${res.location}`)
    },
  )
})
