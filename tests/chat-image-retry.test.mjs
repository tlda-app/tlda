// Regression test for the shared-image race: a chat image can render before
// /api/file is readable. The first load errors, and the chat UI must retry
// instead of keeping a stale broken image until reload — without the visible
// element changing while it retries.
//
// Run: node --test tests/chat-image-retry.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { JSDOM } from 'jsdom'
import { installChatImageRetry, isRetryableChatImage, retryImageUrl, markChatImageUnavailable } from '../src/fleet/chat-image-retry.mjs'

function setupDom(html = '<div id="log"></div>') {
  const dom = new JSDOM(html, { url: 'https://tlda-phi.example/?doc=test' })
  globalThis.HTMLImageElement = dom.window.HTMLImageElement
  globalThis.MutationObserver = dom.window.MutationObserver
  globalThis.Event = dom.window.Event
  return dom
}

test('clears retry state after a successful load', async () => {
  const dom = setupDom('<div id="log"><img class="chat-image" src="/api/file?path=%2Ftmp%2Ffleet-uploads%2Frace.png"></div>')
  const log = dom.window.document.getElementById('log')
  const img = log.querySelector('img')
  const cleanup = installChatImageRetry(log, { baseDelayMs: 1, maxRetries: 2, baseHref: dom.window.location.href })

  img.dispatchEvent(new dom.window.Event('error'))
  await delay(10)
  assert.equal(img.dataset.chatImageRetryCount, '1')

  img.dispatchEvent(new dom.window.Event('load'))
  assert.equal(img.dataset.chatImageRetryCount, undefined)
  assert.equal(img.dataset.chatImageRetrySrc, undefined)

  cleanup()
})

test('only retries chat images served by fleet file routes', () => {
  const dom = setupDom()
  const img = dom.window.document.createElement('img')
  img.className = 'chat-image'
  img.src = 'https://example.test/other.png'
  assert.equal(isRetryableChatImage(img), false)

  img.src = 'https://tlda-phi.example/api/file?path=%2Ftmp%2Ffleet-uploads%2Frace.png'
  assert.equal(isRetryableChatImage(img), true)
})

test('settles on a quiet "image unavailable" marker after retries are exhausted', async () => {
  // Skip's incident: the upload landed as a zero-byte file, so every retry
  // reloads -> broken -> reloads -> blank -> broken (the flapping he saw). Once
  // retries run out, the renderer must stop flapping and leave a quiet marker
  // instead of a raw broken-image icon that keeps reserving image-sized space.
  const dom = setupDom('<div id="log"><img class="chat-image" alt="shot.png" src="/api/file?path=%2Fapp%2Fserver%2Fpersist%2Fuploads%2Fshot.png"></div>')
  const log = dom.window.document.getElementById('log')
  const cleanup = installChatImageRetry(log, { baseDelayMs: 1, maxRetries: 2, baseHref: dom.window.location.href })

  // Drive maxRetries+1 failures: attempts 1 and 2 retry, the third exhausts.
  for (let i = 0; i < 3; i++) {
    const img = log.querySelector('img.chat-image')
    if (!img) break
    img.dispatchEvent(new dom.window.Event('error'))
    await delay(5)
  }

  assert.equal(log.querySelector('img.chat-image'), null, 'broken img is removed')
  const marker = log.querySelector('.chat-image-unavailable')
  assert.ok(marker, 'a terminal unavailable marker replaces the image')
  assert.match(marker.textContent, /shot\.png/, 'marker names the file')
  assert.match(marker.textContent, /unavailable/i)

  cleanup()
})

test('markChatImageUnavailable replaces the image in place and is idempotent', () => {
  const dom = setupDom('<div id="log"><img class="chat-image" alt="pic.png" src="/api/file?path=%2Ftmp%2Fpic.png"></div>')
  const log = dom.window.document.getElementById('log')
  const img = log.querySelector('img')

  assert.equal(markChatImageUnavailable(img), true)
  assert.equal(log.querySelector('img'), null)
  const marker = log.querySelector('.att-upload-failed.chat-image-unavailable')
  assert.ok(marker)
  assert.match(marker.textContent, /pic\.png/)

  // A detached image (already replaced) is a no-op, not a throw.
  assert.equal(markChatImageUnavailable(img), false)
})

test('retryImageUrl preserves original origin and path parameter', () => {
  const url = retryImageUrl(
    'https://tlda-phi.example/api/file?path=%2Ftmp%2Ffleet-uploads%2Frace.png',
    3,
    'https://fallback.example/',
  )
  const parsed = new URL(url)
  assert.equal(parsed.origin, 'https://tlda-phi.example')
  assert.equal(parsed.searchParams.get('path'), '/tmp/fleet-uploads/race.png')
  assert.match(parsed.searchParams.get('chat_img_retry'), /^3-\d+$/)
})
