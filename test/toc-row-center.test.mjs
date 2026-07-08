import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const toc = readFileSync(new URL('../src/panels/TocTab.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/DocumentPanel.css', import.meta.url), 'utf8')

test('TOC has a quiet per-row center button and no bottom center control', () => {
  assert.match(toc, /function renderCenterButton/)
  assert.match(toc, /className="toc-row-center"/)
  assert.match(toc, /aria-label="Center this heading"/)
  assert.doesNotMatch(toc, /toc-center-link/)
  assert.doesNotMatch(toc, /Center the paper horizontally/)
})

test('TOC row title navigation preserves horizontal position while row center recenters the page', () => {
  assert.match(toc, /const handleNav = useCallback\(\(entry: LookupEntry\) => \{[\s\S]*?getViewportPageBounds\(\)[\s\S]*?x: vp\.x \+ vp\.w \/ 2, y: pos\.y/)
  assert.match(toc, /const handleCenterEntry = useCallback\(\(entry: LookupEntry\) => \{[\s\S]*?pageCenterX[\s\S]*?x: pageCenterX, y: pos\.y/)
  assert.match(toc, /nav: \(\) => handleNav\(h\.entry\),\s+center: \(\) => handleCenterEntry\(h\.entry\)/)
})

test('TOC row center styling stays subtle and touch-sized on phone', () => {
  const rowCenter = css.match(/\.toc-row-center \{[\s\S]*?\}/)?.[0] || ''
  assert.match(rowCenter, /opacity: 0\.12/)
  assert.match(rowCenter, /background: transparent/)
  assert.match(rowCenter, /border: 0/)
  assert.doesNotMatch(rowCenter, /box-shadow/)
  assert.match(css, /\.phone-toc-modal \.toc-row-center \{[\s\S]*?width: 22px[\s\S]*?height: 22px/)
})
