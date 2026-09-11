import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { executableChunks, injectQuartoOutputProvenance } from './quarto-output-provenance.mjs'

const source = `---
execute:
  echo: true
---

\`\`\`{r}
#| echo: false
plot(c(1, 2, 3))
\`\`\`

\`\`\`{r}
#| echo: true
print("visible control")
\`\`\`
`

test('executable chunks retain exact source and effective echo', () => {
  assert.deepEqual(executableChunks(source), [
    { echo: false, label: 'unnamed-chunk-1', source: '#| echo: false\nplot(c(1, 2, 3))', sourceLine: 7 },
    { echo: true, label: 'unnamed-chunk-2', source: '#| echo: true\nprint("visible control")', sourceLine: 12 },
  ])
})

test('only an echo-false figure gets an exact source disclosure', () => {
  const html = `<!doctype html><html><body>
    <div class="cell"><div class="cell-output-display"><figure><img src="figure-html/unnamed-chunk-1-1.png"></figure></div></div>
    <div class="cell"><div class="cell-code">visible control</div><div class="cell-output">result</div></div>
  </body></html>`
  const result = injectQuartoOutputProvenance(html, source, 'chapter.qmd')
  const document = new JSDOM(result).window.document
  const details = document.querySelectorAll('details.tlda-output-source')
  assert.equal(details.length, 1)
  assert.equal(details[0].querySelector('summary').textContent, 'Show plotting code')
  assert.equal(details[0].querySelector('code').textContent, '#| echo: false\nplot(c(1, 2, 3))')
  assert.equal(details[0].dataset.sourceFile, 'chapter.qmd')
  assert.equal(details[0].dataset.sourceLine, '7')
  assert.equal(document.querySelectorAll('.cell-code').length, 1, 'visible Quarto code stays visible')
  assert.equal(
    new JSDOM(injectQuartoOutputProvenance(result, source, 'chapter.qmd')).window.document.querySelectorAll('details.tlda-output-source').length,
    1,
    'a component rebuild does not duplicate the disclosure',
  )
})

test('a real Quarto render reveals hidden plotting code and preserves visible code', { timeout: 120_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-quarto-provenance-'))
  const file = join(dir, 'control.qmd')
  const rendered = join(dir, 'control.html')
  const control = `---
title: Control
format: html
---

\`\`\`{r}
#| echo: false
plot(c(1, 2, 3))
\`\`\`

\`\`\`{r}
#| echo: true
print("visible control")
\`\`\`
`
  try {
    writeFileSync(file, control)
    execFileSync('quarto', ['render', file], { cwd: dir, stdio: 'ignore' })
    const quartoHtml = readFileSync(rendered, 'utf8')
    assert.doesNotMatch(quartoHtml, /plot\(c\(1, 2, 3\)\)/, 'Quarto really hid the plotting chunk')
    assert.match(quartoHtml, /visible control/, 'Quarto really emitted the visible-code control')

    const document = new JSDOM(injectQuartoOutputProvenance(quartoHtml, control, 'control.qmd')).window.document
    assert.equal(document.querySelectorAll('details.tlda-output-source').length, 1)
    assert.equal(document.querySelector('details.tlda-output-source code').textContent, '#| echo: false\nplot(c(1, 2, 3))')
    assert.match(document.querySelector('.cell-code').textContent, /visible control/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
