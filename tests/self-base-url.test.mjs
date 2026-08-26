/**
 * The server's self-remote uses the host it is reachable at, not loopback.
 *
 * A TLS preview serves TWO certs by SNI, on purpose: `localhost`/`127.0.0.1`/
 * `::1` get the mkcert developer cert and every other name gets the tailnet
 * cert. git's CA store has Let's Encrypt and not Skip's mkcert root, so a
 * self-push aimed at loopback dies:
 *
 *   fatal: unable to access 'https://127.0.0.1:5191/git/…':
 *   SSL certificate problem: unable to get local issuer certificate
 *
 * Measured on two independent previews. The counterfactual is the second test:
 * a server told nothing must still use loopback, or this repair would have
 * pointed every ordinary server at whatever a stray variable said.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { selfBaseUrl } from '../shared/self-base-url.mjs'

const PREVIEW = 'https://davids-mac-mini.example.ts.net:5190'

test('a TLS preview uses the cert-valid host it was handed', () => {
  const url = new URL(selfBaseUrl({ supplied: PREVIEW, useTls: true, port: 5190 }))
  assert.equal(url.hostname, 'davids-mac-mini.example.ts.net')
  assert.notEqual(url.hostname, '127.0.0.1', 'the host the mkcert cert answers for')
  assert.equal(url.protocol, 'https:')
})

test('ordinary startup keeps loopback — nothing was supplied', () => {
  assert.equal(selfBaseUrl({ useTls: false, port: 3000 }), 'http://127.0.0.1:3000')
  assert.equal(selfBaseUrl({ supplied: null, useTls: true, port: 8443 }), 'https://127.0.0.1:8443')
  // An empty or whitespace value is not a hostname. It is an unset variable
  // arriving as a string, which is how env vars fail.
  assert.equal(selfBaseUrl({ supplied: '', useTls: false, port: 3000 }), 'http://127.0.0.1:3000')
  assert.equal(selfBaseUrl({ supplied: '   ', useTls: false, port: 3000 }), 'http://127.0.0.1:3000')
})

test('a trailing slash does not become a doubled one in the git path', () => {
  // The value is used as a URL base, and `new URL('/git/x', base)` is fine
  // either way — but the string is also logged and compared, so normalize it.
  const base = selfBaseUrl({ supplied: `${PREVIEW}//`, useTls: true, port: 5190 })
  assert.equal(base, PREVIEW)
  assert.equal(new URL('/git/paper', base).href, `${PREVIEW}/git/paper`)
})
