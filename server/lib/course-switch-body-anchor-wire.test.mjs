import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { request } from 'node:https'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { removeTempDir } from './test-support/remove-temp-dir.mjs'

/**
 * A rendered deck contains more than one `</body>`, and only the last one is the
 * document's. Quarto's RevealNotes plugin writes the speaker-view popup as a
 * JavaScript string that contains a whole HTML document — `...</body>\n</html>")`
 * — so the FIRST `</body>` in the served file is inside a JS string literal, tens
 * of thousands of bytes before the real one.
 *
 * An anchor spliced at that first occurrence lands inside the literal, where its
 * double quotes terminate the string: the deck then fails to parse and Reveal
 * never initializes, while the page is still served 200 with nothing logged.
 *
 * So the assertion is JavaScript validity of the served bytes rather than the
 * anchor's presence, because a presence check cannot fail for this.
 */

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForServer(child) {
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const deadline = Date.now() + 90_000
  while (!output.includes('Unified server running')) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  child.kill('SIGTERM')
  await new Promise(resolve => child.once('exit', resolve))
}

// Its own TLS-tolerant fetch rather than `fetch`, so the result does not depend
// on whoever ran the suite having NODE_TLS_REJECT_UNAUTHORIZED set.
async function get(port, path) {
  return await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, rejectUnauthorized: false }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.once('end', () => resolve({ status: res.statusCode, body }))
    })
    req.once('error', reject)
    req.end()
  })
}

/** Inline scripts, delimited the way a browser delimits them: at `</script>`. */
function inlineScripts(html) {
  const found = []
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  for (let m = pattern.exec(html); m; m = pattern.exec(html)) {
    const attributes = m[1]
    if (/\bsrc\s*=/i.test(attributes)) continue
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1]
    if (type && !/^(text\/javascript|application\/javascript)$/i.test(type)) continue
    const text = m[2].trim()
    if (text) found.push({ index: m.index, text })
  }
  return found
}

// The upstream shape, reduced: the popup string holds an escaped `<\/script>`
// and a RAW `</body>`, then the document's own `</body>` follows. That is what
// the served deck actually contains — the plugin escapes only the sequence that
// would end the element, so the first `</body>` in the file is this one.
const DECK = `<!doctype html>
<html>
<head><title>Calibrating Interval Estimates using the Bootstrap</title></head>
<body class="reveal-viewport">
<div class="reveal"><div class="slides"><section id="first"><h1>One</h1></section></div></div>
<script>
  window.openSpeakerView = function () {
    var popup = window.open('', 'reveal.js - Notes', 'width=1100,height=700')
    popup.document.write("<html><head><\\/head><body><script>Reveal.initialize()<\\/script></body>\\n</html>")
    if (!popup) alert('Speaker view popup failed to open.')
  }
</script>
</body>
</html>
`

test('the course presentation switch lands on the document body, not an earlier one inside a script', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-course-switch-anchor-'))
  const projects = join(root, 'projects')
  const project = join(projects, 'qtm285-book')
  const deckDir = join(project, 'output', 'static', 'book', 'decks')
  const deckPath = 'static/book/decks/chapter-bootstrap-slides.html'
  mkdirSync(deckDir, { recursive: true })
  mkdirSync(join(project, 'source'), { recursive: true })
  writeFileSync(join(project, 'project.json'), JSON.stringify({ name: 'qtm285-book', title: 'Book', format: 'html' }))
  writeFileSync(join(project, 'output', 'page-info.json'), JSON.stringify([
    { file: deckPath, width: 1050, height: 700, title: 'Calibrating Interval Estimates using the Bootstrap' },
  ]))
  writeFileSync(join(deckDir, 'chapter-bootstrap-slides.html'), DECK)

  // The fixture is only worth serving if it carries the defect's precondition.
  assert.notEqual(DECK.indexOf('</body>'), DECK.lastIndexOf('</body>'), 'fixture lost its earlier </body>')

  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PROJECTS_DIR: projects,
      TLDA_FLEET_DB: join(root, 'fleet.db'),
      TLDA_DEV_SERVER: '1',
      TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await waitForServer(child)
    const served = await get(port, `/docs/qtm285-book/${deckPath}`)
    assert.equal(served.status, 200)
    const html = served.body

    // The symptom itself, asserted first so a failure names what the browser
    // sees: with the anchor spliced into the popup string, this script does not
    // parse, and the deck is blank.
    const scripts = inlineScripts(html)
    assert.ok(scripts.length > 0, 'found no inline scripts in the served deck to check')
    for (const { index, text } of scripts) {
      assert.doesNotThrow(
        () => new vm.Script(text),
        `inline script at byte ${index} of the served deck is not valid JavaScript`,
      )
    }

    const anchors = [...html.matchAll(/class="tlda-presentation-switch"/g)]
    assert.equal(anchors.length, 1, 'the switch is injected exactly once')

    const firstBody = html.indexOf('</body>')
    const lastBody = html.lastIndexOf('</body>')
    assert.notEqual(firstBody, lastBody, 'served deck lost the earlier </body> the defect needs')
    assert.ok(
      anchors[0].index > firstBody && anchors[0].index < lastBody,
      `switch sits at byte ${anchors[0].index}; the script's </body> is at ${firstBody} and the document's at ${lastBody}`,
    )
  } finally {
    await stopServer(child)
    removeTempDir(root)
  }
})
