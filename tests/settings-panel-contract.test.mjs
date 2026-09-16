import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const prefsTabSource = readFileSync(new URL('../src/panels/PrefsTab.tsx', import.meta.url), 'utf8')
const tocTabSource = readFileSync(new URL('../src/panels/TocTab.tsx', import.meta.url), 'utf8')
const documentPanelSource = readFileSync(new URL('../src/DocumentPanel.tsx', import.meta.url), 'utf8')
const documentPanelCss = readFileSync(new URL('../src/DocumentPanel.css', import.meta.url), 'utf8')
const preferencesSource = readFileSync(new URL('../src/preferences.ts', import.meta.url), 'utf8')

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

test('TOC compact controls setting is live and keeps labelled mode as the default', () => {
  assert.match(preferencesSource, /'toc-controls-compact': false as boolean/)
  assert.match(prefsTabSource, /checked=\{prefs\.tocControlsCompact\}[\s\S]*setPref\('toc-controls-compact', e\.target\.checked\)/)
  assert.match(tocTabSource, /useSyncExternalStore\(subscribePref, \(\) => getPref\('toc-controls-compact'\)\)/)
})

test('TOC button mode is live and defaults on while constrained surfaces stay button-driven', () => {
  assert.match(preferencesSource, /'toc-button-mode': true as boolean/)
  assert.match(prefsTabSource, /checked=\{prefs\.tocButtonMode\}[\s\S]*setPref\('toc-button-mode', e\.target\.checked\)/)
  assert.match(documentPanelSource, /useSyncExternalStore\(subscribePref, \(\) => getPref\('toc-button-mode'\)\)/)
  assert.match(documentPanelSource, /buttonMode \|\| doc\?\.format === 'slides' \|\| isPhone \|\| IS_TOUCH_DEVICE/)
})

test('TOC keeps its established control order and can compact the state controls', () => {
  assert.match(tocTabSource, /toc-bottom-controls.*toc-bottom-controls--compact[\s\S]*<PlaceStackNav \/>[\s\S]*<CameraLinkToggle \/>[\s\S]*<JoinVoiceVideoToggle \/>[\s\S]*onToggleWholeDocumentDiff[\s\S]*<AirplaneIcon \/>/)
  assert.match(documentPanelCss, /\.toc-bottom-controls--compact \.toc-state-control \{[\s\S]*width: 22px;[\s\S]*height: 22px/)
  assert.match(documentPanelCss, /\.toc-bottom-controls--compact \.toc-state-control-label \{[\s\S]*display: none/)
})

test('corner controls retain their dormant resting opacity without hover', () => {
  assert.doesNotMatch(documentPanelCss, /@media \(hover: none\)[\s\S]*\.phone-hl-btn,[\s\S]*\.voice-note-btn,[\s\S]*\.mic-toggle-btn[\s\S]*opacity: var\(--ui-tone-active\)/)
})
