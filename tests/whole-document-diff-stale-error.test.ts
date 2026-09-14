/**
 * Stale `Diff failed` after the failing condition is gone.
 *
 * Intention: prove the user-visible stuck state in `useWholeDocumentDiff`
 * before repairing it. The effect's early-return path (hidden diff, no hash,
 * no column, or no pages) clears shapes and loading but never clears the
 * error, while the proceed path does (`setError(null)`). So once a whole-
 * document diff fails, the scrubber button can keep reading `Diff failed`
 * after the cause is gone.
 *
 * Instrument: render the real hook behind a button whose label is the exact
 * expression from the scrubber (`src/panels/TocTab.tsx`, the
 * `wholeDocumentDiffLoading ? 'Diffing…' : wholeDocumentDiffError
 * ? 'Diff failed' : …` line). Fail the diff via a mocked `fetch`, remove the
 * failure, then take the early-return path the way a person does — by
 * clicking the button, which toggles the diff off. The button must read
 * `Show diff` again. On unfixed `main` it still reads `Diff failed`.
 *
 * Reachability: the `!visible` early-return leg is one click away. The click
 * sequence below (show → fail → click the failed button) is the natural thing
 * a person does after a failure; no reload, no devtools. The fetch mock means
 * this test does not depend on the real ENOENT/500 behind the current
 * failures continuing to exist.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const FAIL_ONCE = new Response('{}', { status: 500 })
const RECOVERED = Response.json({ shapeIds: [] })

async function setup(fetchImpl: (url: string) => Promise<Response>) {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.invalid/' })
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: fetchImpl,
  })
  const react = await import('react')
  const { act, createElement, useRef } = react
  Object.assign(globalThis, { React: react })
  const { createRoot } = await import('react-dom/client')
  const { useWholeDocumentDiff } = await import('../src/hooks/useWholeDocumentDiff')

  function Harness() {
    const editorRef = useRef(null)
    const {
      wholeDocumentDiffVisible,
      wholeDocumentDiffLoading,
      wholeDocumentDiffError,
      toggleWholeDocumentDiff,
    } = useWholeDocumentDiff(editorRef, 'test-proj', 'abcdef123456', 1, 500, 0)
    // Same expression as the scrubber button in src/panels/TocTab.tsx.
    const label = wholeDocumentDiffLoading
      ? 'Diffing…'
      : wholeDocumentDiffError
        ? 'Diff failed'
        : wholeDocumentDiffVisible
          ? 'Hide diff'
          : 'Show diff'
    return createElement('button', { type: 'button', onClick: toggleWholeDocumentDiff }, label)
  }

  const root = createRoot(dom.window.document.getElementById('root')!)
  await act(async () => { root.render(createElement(Harness)) })
  const button = () => dom.window.document.querySelector('button')!
  async function flush(ticks = 4) {
    for (let i = 0; i < ticks; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    }
  }
  async function click() {
    await act(async () => {
      button().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await flush()
  }
  return { button, click, flush, cleanup: () => { root.unmount(); dom.window.close() } }
}

test('toggling the diff off after a failure clears the scrubber error', async () => {
  let calls = 0
  const ui = await setup(async () => (calls === 0 ? (calls += 1, FAIL_ONCE) : RECOVERED))
  try {
    assert.equal(ui.button().textContent, 'Show diff')
    await ui.click()
    assert.equal(ui.button().textContent, 'Diff failed', 'the mocked failure must surface first, or nothing below means anything')
    // The failing condition is now gone (fetch recovers) and the person
    // clicks the button, toggling the diff off through the early-return path.
    await ui.click()
    assert.equal(
      ui.button().textContent,
      'Show diff',
      'after the cause is gone and the diff is toggled off, the scrubber must not keep reading `Diff failed`',
    )
  } finally { ui.cleanup() }
})

test('positive control: re-showing the diff after recovery renders it', async () => {
  let calls = 0
  const ui = await setup(async () => (calls === 0 ? (calls += 1, FAIL_ONCE) : RECOVERED))
  try {
    await ui.click()
    assert.equal(ui.button().textContent, 'Diff failed')
    await ui.click()
    await ui.click()
    await ui.flush(6)
    assert.equal(ui.button().textContent, 'Hide diff', 'the instrument must be able to reach the rendered state once fetch recovers')
  } finally { ui.cleanup() }
})
