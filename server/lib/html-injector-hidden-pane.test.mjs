import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { JSDOM } from '../../node_modules/jsdom/lib/api.js'

const here = dirname(fileURLToPath(import.meta.url))
const INJECTOR = join(here, 'html-injector.mjs')

// Extract the bridge's hidden-pane measurement helper the same way the
// syntax test does: evaluate the template literal so the escaping is the
// runtime's, then slice the helper out of the evaluated script.
function measureHelper() {
  const src = readFileSync(INJECTOR, 'utf8')
  const decl = /const ([A-Z0-9_]+_SCRIPT) = `/g
  let bridge = null
  for (let m = decl.exec(src); m; m = decl.exec(src)) {
    const open = src.indexOf('`', m.index)
    const end = src.indexOf('\n`\n', open)
    if (end === -1) continue
    if (m[1] !== 'BRIDGE_SCRIPT') continue
    bridge = new vm.Script('`' + src.slice(open + 1, end) + '`').runInNewContext({})
  }
  assert.ok(bridge, 'BRIDGE_SCRIPT not found')
  const text = bridge.replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '')
  const start = text.indexOf('function measureWithHiddenPanesShown')
  const end = text.indexOf('function reportHeadings')
  assert.ok(start !== -1 && end > start, 'hidden-pane helper not found in bridge')
  return text.slice(start, end)
}

function measureAnchor(helperSrc) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
<div class="tab-content"><div class="tab-pane" id="pane-a" style="display:none;"><div id="fig-neighbors-letter">FIG</div></div></div>
</body></html>`, { pretendToBeVisual: true })
  const { document } = dom.window
  const fig = document.getElementById('fig-neighbors-letter')
  const pane = document.getElementById('pane-a')
  // jsdom has no layout engine: emulate the browser, where an element under
  // an inactive tab pane measures 0 but measures a real offset once the
  // pane carries the active class (Bootstrap hides .tab-pane:not(.active)).
  Object.defineProperty(fig, 'offsetTop', {
    get() { return pane.classList.contains('active') ? 1234 : 0 },
    configurable: true,
  })
  const out = vm.runInNewContext(helperSrc + `
    ;var positions = {};
    (function() {
      var el = document.getElementById('fig-neighbors-letter');
      positions['fig-neighbors-letter'] = measureWithHiddenPanesShown(el, function() {
        var y = 0; var node = el;
        while (node) { y += node.offsetTop || 0; node = node.offsetParent; }
        return y;
      });
    })();
    positions;`, { document })
  return { y: out['fig-neighbors-letter'], activeAfter: pane.classList.contains('active') }
}

test('anchors inside an inactive tab pane measure their real offset, not 0', () => {
  const { y, activeAfter } = measureAnchor(measureHelper())
  assert.equal(y, 1234, 'inactive-pane anchor stayed at 0')
  assert.equal(activeAfter, false, 'pane was left activated after measuring')
})
