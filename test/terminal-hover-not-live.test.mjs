import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const server = readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
const chatShape = readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/shapes/fleet-chat.css', import.meta.url), 'utf8')

test('terminal hover seed failure sends a not-live frame and removes seed diagnostics', () => {
  assert.match(server, /type: 'not-live', reason: 'terminal session not live'/)
  assert.doesNotMatch(server, /\[term-seed\]/)
  assert.match(server, /\[terminal\] seed capture failed/)
})

test('terminal hover client renders not-live state and recovers on output', () => {
  assert.match(chatShape, /const \[notLive, setNotLive\] = useState\(false\)/)
  assert.match(chatShape, /setStatus\('connecting'\)\s+setNotLive\(false\)/)
  assert.match(chatShape, /msg\.type === 'output' && msg\.data && termRef\.current\) \{\s+setNotLive\(false\)/)
  assert.match(chatShape, /msg\.type === 'error'\) \{\s+setNotLive\(true\)\s+setStatus\('error'\)/)
  assert.match(chatShape, /msg\.type === 'not-live'\) \{\s+setNotLive\(true\)/)
  assert.match(chatShape, /className="fleet-terminal-hover-notlive">terminal not live/)
  assert.doesNotMatch(chatShape, /term-hover/)
  assert.doesNotMatch(chatShape, /noSeedTimer|sawOutput|sawSizeMsg|sawErrorMsg|output-first/)
})

test('terminal hover icon gating hides only hard-dead agents', () => {
  const fn = chatShape.match(/const isTerminalReadyAgent = useCallback\(\(agent: any\) => \{\n([\s\S]*?)\n  \}, \[\]\)/)
  assert.ok(fn, 'expected isTerminalReadyAgent helper')
  assert.match(fn[1], /agent\.dead !== true/)
  assert.doesNotMatch(fn[1], /tmux_session|hibernating|status/)
})

test('terminal not-live message is quiet inline text', () => {
  assert.match(css, /\.fleet-chat-shape \.fleet-terminal-hover-notlive \{[\s\S]*color: rgba\(168, 168, 192, 0\.3\)/)
  assert.match(css, /\.fleet-chat-shape \.fleet-terminal-hover-notlive \{[\s\S]*font-size: 10px/)
  assert.doesNotMatch(css.match(/\.fleet-chat-shape \.fleet-terminal-hover-notlive \{[\s\S]*?\}/)?.[0] || '', /border|box-shadow|background/)
})
