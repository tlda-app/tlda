import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { attachIndexChatTail } from '../src/index-chat-tail.mjs'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('index chat exposes voice send in its placeholder and has no false All control', () => {
  assert.match(appSource, /return submitWord \? `Message \$\{agentName\} · say “\$\{submitWord\}” to send` : `Message \$\{agentName\}`/)
  assert.match(appSource, /const chromeComposerPlaceholder = selectedAgent \? composerPlaceholder\(selectedAgent\.displayName, voiceSubmitWords\) : ''/)
  assert.doesNotMatch(appSource, />All<\/button>/)
})

test('index chat follows the tail immediately and whenever rendered content changes height', () => {
  const listeners = new Map()
  const removedListeners = new Map()
  const log = {
    scrollTop: 0,
    scrollHeight: 240,
    clientHeight: 120,
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
    removeEventListener(type, listener) {
      removedListeners.set(type, listener)
      if (listeners.get(type) === listener) listeners.delete(type)
    },
  }
  const rows = {}
  let resize = null
  let observed = null
  let disconnected = false

  class FakeResizeObserver {
    constructor(callback) { resize = callback }
    observe(target) { observed = target }
    disconnect() { disconnected = true }
  }

  const detach = attachIndexChatTail(log, rows, FakeResizeObserver)
  assert.equal(log.scrollTop, 240)
  assert.equal(observed, rows)
  assert.deepEqual([...listeners.keys()], ['scroll', 'wheel', 'touchstart', 'touchmove', 'keydown'])

  log.scrollHeight = 420
  resize()
  assert.equal(log.scrollTop, 420)

  detach()
  assert.deepEqual([...removedListeners.keys()], ['scroll', 'wheel', 'touchstart', 'touchmove', 'keydown'])
  assert.deepEqual([...listeners.keys()], [])
  assert.equal(disconnected, true)
})
