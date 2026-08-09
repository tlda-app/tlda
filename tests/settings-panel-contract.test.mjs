import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const prefsTabSource = readFileSync(new URL('../src/panels/PrefsTab.tsx', import.meta.url), 'utf8')

test('Preferences renders inside the document panel scroll container', () => {
  assert.match(prefsTabSource, /className="doc-panel-content prefs-tab"/)
})

test('Radio has one discoverable persistent off control in Preferences', () => {
  assert.match(prefsTabSource, /setPref\('radio-subtitles-enabled', e\.target\.checked\)/)
  assert.equal(prefsTabSource.match(/radio-subtitles-enabled/g)?.length, 2)
  assert.match(prefsTabSource, /<CollapsiblePrefsSection[\s\S]*id="radio"[\s\S]*title="Radio"[\s\S]*<PrefSubsection title="Radio">[\s\S]*<input type="checkbox" checked=\{prefs\.radioSubtitlesEnabled\}/)
  assert.match(prefsTabSource, /<span>Agent subtitles<\/span>/)
})

test('Appearance exposes the document panel hover-region width', () => {
  assert.match(prefsTabSource, /<ZoneWidthThumbControl className="prefs-zone-width-slider" \/>/)
  assert.match(prefsTabSource, /<span className="prefs-num-label">ToC hover region<\/span>/)
})
