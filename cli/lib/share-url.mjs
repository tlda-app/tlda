import { execFileSync, execSync } from 'child_process'
import { networkInterfaces } from 'os'

export function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

export function isTailscaleIPv4(ip) {
  const parts = String(ip || '').split('.').map(n => Number(n))
  return parts.length === 4 &&
    parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    parts[0] === 100 &&
    parts[1] >= 64 &&
    parts[1] <= 127
}

export function findTailscaleIPv4(interfaces = networkInterfaces()) {
  const ips = []
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      if (entry?.family === 'IPv4' && !entry.internal && isTailscaleIPv4(entry.address)) {
        ips.push(entry.address)
      }
    }
  }
  return ips[0] || null
}

export function getFunnelUrl(run = execShell) {
  let status = null
  if (run === execShell) {
    try {
      status = execFileSync('tailscale', ['funnel', 'status'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    } catch {
      status = null
    }
  } else {
    status = run('tailscale funnel status')
  }
  const match = status?.match(/https:\/\/\S+\.ts\.net/)
  return match?.[0] || null
}

export function execShell(command) {
  try {
    return execSync(command, { encoding: 'utf8', timeout: 5000 }).trim()
  } catch {
    return null
  }
}

export function selectDocShareBase({ serverUrl, port, funnelUrl = null, tailscaleIp = null, hasTls = false }) {
  const parsed = new URL(serverUrl)
  if (!isLoopbackHost(parsed.hostname)) {
    return { kind: 'configured', label: 'Configured server', base: parsed.origin, shareable: true }
  }
  if (funnelUrl) {
    return { kind: 'funnel', label: 'Funnel (public)', base: funnelUrl.replace(/\/+$/, ''), shareable: true }
  }
  if (tailscaleIp) {
    const scheme = hasTls ? 'https' : 'http'
    return { kind: 'tailscale', label: 'Tailscale', base: `${scheme}://${tailscaleIp}:${port}`, shareable: true }
  }
  return {
    kind: 'unavailable',
    label: 'No shareable URL',
    base: `${hasTls ? 'https' : 'http'}://localhost:${port}`,
    shareable: false,
    reason: 'active server is localhost and no Tailscale IP/Funnel URL is available',
  }
}

export function selectDevShareBase({ scheme, port, tailscaleIp = null }) {
  if (tailscaleIp) {
    return { kind: 'tailscale', label: 'Tailscale', base: `${scheme}://${tailscaleIp}:${port}`, shareable: true }
  }
  return {
    kind: 'unavailable',
    label: 'No shareable URL',
    base: `${scheme}://localhost:${port}`,
    shareable: false,
    reason: 'no Tailscale IPv4 interface is available on this machine',
  }
}

export function viewerLoginUrl(base, docName, token) {
  const redirect = docName ? `/?doc=${docName}` : '/'
  return `${base.replace(/\/+$/, '')}/auth/login?token=${encodeURIComponent(token)}&redirect=${encodeURIComponent(redirect)}`
}
