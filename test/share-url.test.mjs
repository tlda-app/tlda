import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  findLanIPv4,
  findTailscaleIPv4,
  isLanIPv4,
  isLoopbackHost,
  isTailscaleIPv4,
  LAN_CERT_NOTE,
  selectDevShareBase,
  selectDocShareBase,
  viewerLoginUrl,
} from '../cli/lib/share-url.mjs'

describe('share URL selection', () => {
  it('recognizes loopback and Tailscale hosts', () => {
    assert.equal(isLoopbackHost('localhost'), true)
    assert.equal(isLoopbackHost('127.0.0.1'), true)
    assert.equal(isLoopbackHost('tlda-fly.cormorant-matrix.ts.net'), false)

    assert.equal(isTailscaleIPv4('100.64.0.1'), true)
    assert.equal(isTailscaleIPv4('100.127.255.254'), true)
    assert.equal(isTailscaleIPv4('100.128.0.1'), false)
    assert.equal(isTailscaleIPv4('192.168.1.50'), false)
  })

  it('finds a Tailscale IPv4 address from Node network interfaces', () => {
    const ip = findTailscaleIPv4({
      lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      en0: [{ family: 'IPv4', address: '192.168.1.50', internal: false }],
      utun9: [{ family: 'IPv4', address: '100.88.45.64', internal: false }],
    })
    assert.equal(ip, '100.88.45.64')
  })

  it('uses the configured remote server for document sharing', () => {
    const selected = selectDocShareBase({
      serverUrl: 'https://tlda-fly.cormorant-matrix.ts.net',
      port: '5176',
      tailscaleIp: '100.88.45.64',
      funnelUrl: 'https://mini.example.ts.net',
      hasTls: true,
    })

    assert.deepEqual(selected, {
      kind: 'configured',
      label: 'Configured server',
      base: 'https://tlda-fly.cormorant-matrix.ts.net',
      shareable: true,
    })
  })

  it('uses the active local server scheme for localhost document sharing over Tailscale', () => {
    const selected = selectDocShareBase({
      serverUrl: 'https://localhost:5176',
      port: '5176',
      tailscaleIp: '100.88.45.64',
      funnelUrl: null,
      hasTls: true,
    })

    assert.equal(selected.kind, 'tailscale')
    assert.equal(selected.base, 'https://100.88.45.64:5176')
    assert.equal(selected.shareable, true)

    const plain = selectDocShareBase({
      serverUrl: 'http://localhost:5176',
      port: '5176',
      tailscaleIp: '100.88.45.64',
      funnelUrl: null,
      hasTls: false,
    })
    assert.equal(plain.base, 'http://100.88.45.64:5176')
  })

  it('does not treat localhost document URLs as shareable', () => {
    const selected = selectDocShareBase({
      serverUrl: 'https://localhost:5176',
      port: '5176',
      tailscaleIp: null,
      funnelUrl: null,
      hasTls: true,
    })

    assert.equal(selected.kind, 'unavailable')
    assert.equal(selected.shareable, false)
    assert.match(selected.reason, /localhost/)
  })

  it('recognizes private LAN IPv4 ranges and excludes Tailscale CGNAT', () => {
    assert.equal(isLanIPv4('10.0.0.5'), true)
    assert.equal(isLanIPv4('172.16.0.1'), true)
    assert.equal(isLanIPv4('172.31.255.254'), true)
    assert.equal(isLanIPv4('172.15.0.1'), false)
    assert.equal(isLanIPv4('172.32.0.1'), false)
    assert.equal(isLanIPv4('192.168.1.50'), true)
    assert.equal(isLanIPv4('100.88.45.64'), false)
    assert.equal(isLanIPv4('8.8.8.8'), false)
  })

  it('finds a LAN IPv4 address, skipping loopback and Tailscale interfaces', () => {
    assert.equal(findLanIPv4({
      lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      utun9: [{ family: 'IPv4', address: '100.88.45.64', internal: false }],
      en0: [{ family: 'IPv4', address: '192.168.1.50', internal: false }],
    }), '192.168.1.50')

    assert.equal(findLanIPv4({
      lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    }), null)
  })

  it('prefers Tailscale over LAN for document sharing', () => {
    const selected = selectDocShareBase({
      serverUrl: 'https://localhost:5176',
      port: '5176',
      tailscaleIp: '100.88.45.64',
      lanIp: '192.168.1.50',
      funnelUrl: null,
      hasTls: true,
    })
    assert.equal(selected.kind, 'tailscale')
    assert.equal(selected.base, 'https://100.88.45.64:5176')
  })

  it('falls back to LAN when no Tailscale IP is available', () => {
    const selected = selectDocShareBase({
      serverUrl: 'https://localhost:5176',
      port: '5176',
      tailscaleIp: null,
      lanIp: '192.168.1.50',
      funnelUrl: null,
      hasTls: true,
    })
    assert.equal(selected.kind, 'lan')
    assert.equal(selected.base, 'https://192.168.1.50:5176')
    assert.equal(selected.shareable, true)
    assert.equal(selected.note, LAN_CERT_NOTE)

    const plain = selectDocShareBase({
      serverUrl: 'http://localhost:5176',
      port: '5176',
      tailscaleIp: null,
      lanIp: '192.168.1.50',
      funnelUrl: null,
      hasTls: false,
    })
    assert.equal(plain.kind, 'lan')
    assert.equal(plain.base, 'http://192.168.1.50:5176')
    assert.equal(plain.note, undefined)
  })

  it('falls back to LAN for dev server sharing when no Tailscale IP exists', () => {
    const selected = selectDevShareBase({ scheme: 'https', port: 5180, tailscaleIp: null, lanIp: '10.0.0.5' })
    assert.equal(selected.kind, 'lan')
    assert.equal(selected.base, 'https://10.0.0.5:5180')
    assert.equal(selected.shareable, true)
    assert.equal(selected.note, LAN_CERT_NOTE)

    const preferred = selectDevShareBase({ scheme: 'http', port: 5180, tailscaleIp: '100.88.45.64', lanIp: '10.0.0.5' })
    assert.equal(preferred.kind, 'tailscale')
  })

  it('uses Tailscale for dev server sharing and refuses localhost-only output', () => {
    const selected = selectDevShareBase({ scheme: 'http', port: 5180, tailscaleIp: '100.88.45.64' })
    assert.equal(selected.base, 'http://100.88.45.64:5180')
    assert.equal(selected.shareable, true)

    const unavailable = selectDevShareBase({ scheme: 'http', port: 5180, tailscaleIp: null })
    assert.equal(unavailable.shareable, false)
    assert.equal(unavailable.base, 'http://localhost:5180')
  })

  it('builds read-token login URLs without leaking token into redirect', () => {
    const url = viewerLoginUrl('https://tlda-fly.cormorant-matrix.ts.net', 'bregman', 'read token')
    assert.equal(
      url,
      'https://tlda-fly.cormorant-matrix.ts.net/auth/login?token=read%20token&redirect=%2F%3Fdoc%3Dbregman',
    )
  })

  it('redirects to the index page when no doc name is given (no-arg share)', () => {
    // `tlda doc share` with no arg → docName=null → redirect to root `/`.
    const url = viewerLoginUrl('https://100.88.45.64:5176', null, 'tok')
    assert.equal(url, 'https://100.88.45.64:5176/auth/login?token=tok&redirect=%2F')
  })

  it('redirects to a specific doc when a name is given (`.`-inferred or explicit)', () => {
    // Both `tlda doc share .` (cwd-inferred name) and `tlda doc share NAME`
    // resolve a doc name and redirect to `/?doc=NAME`.
    const url = viewerLoginUrl('https://100.88.45.64:5176', 'bregman', 'tok')
    assert.equal(url, 'https://100.88.45.64:5176/auth/login?token=tok&redirect=%2F%3Fdoc%3Dbregman')
  })
})
