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

// RFC1918 private LAN ranges: 10.0.0.0/8, 172.16.0.0/12 (172.16–31), 192.168.0.0/16.
// Tailscale CGNAT (100.64–127) is NOT in any of these, so it can never match here —
// no double-count with findTailscaleIPv4.
export function isLanIPv4(ip) {
  const parts = String(ip || '').split('.').map(n => Number(n))
  if (parts.length !== 4 || !parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return false
  const [a, b] = parts
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

export function findLanIPv4(interfaces = networkInterfaces()) {
  const ips = []
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      if (entry?.family === 'IPv4' && !entry.internal && isLanIPv4(entry.address)) {
        ips.push(entry.address)
      }
    }
  }
  return ips[0] || null
}

// Sharing over the LAN to another device uses the localhost mkcert cert, whose
// SANs don't cover the LAN IP — so https clients see a one-time trust prompt.
export const LAN_CERT_NOTE = 'HTTPS cert is for localhost — other devices may show a one-time cert-trust warning'

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

export function selectDocShareBase({ serverUrl, port, funnelUrl = null, tailscaleIp = null, lanIp = null, hasTls = false }) {
  const parsed = new URL(serverUrl)
  if (!isLoopbackHost(parsed.hostname)) {
    return { kind: 'configured', label: 'Configured server', base: parsed.origin, shareable: true }
  }
  if (funnelUrl) {
    return { kind: 'funnel', label: 'Funnel (public)', base: funnelUrl.replace(/\/+$/, ''), shareable: true }
  }
  const scheme = hasTls ? 'https' : 'http'
  // Tailscale is PREFERRED over LAN — its cert is valid for the tailnet host,
  // whereas the LAN IP reuses the localhost cert (trust prompt). LAN is the next
  // fallback for the same-wifi-no-Tailscale case (iPad → laptop).
  if (tailscaleIp) {
    return { kind: 'tailscale', label: 'Tailscale', base: `${scheme}://${tailscaleIp}:${port}`, shareable: true }
  }
  if (lanIp) {
    return {
      kind: 'lan', label: 'Local network', base: `${scheme}://${lanIp}:${port}`, shareable: true,
      ...(scheme === 'https' ? { note: LAN_CERT_NOTE } : {}),
    }
  }
  return {
    kind: 'unavailable',
    label: 'No shareable URL',
    base: `${scheme}://localhost:${port}`,
    shareable: false,
    reason: 'active server is localhost and no Tailscale IP/LAN IP/Funnel URL is available',
  }
}

export function selectDevShareBase({ scheme, port, tailscaleIp = null, lanIp = null }) {
  if (tailscaleIp) {
    return { kind: 'tailscale', label: 'Tailscale', base: `${scheme}://${tailscaleIp}:${port}`, shareable: true }
  }
  if (lanIp) {
    return {
      kind: 'lan', label: 'Local network', base: `${scheme}://${lanIp}:${port}`, shareable: true,
      ...(scheme === 'https' ? { note: LAN_CERT_NOTE } : {}),
    }
  }
  return {
    kind: 'unavailable',
    label: 'No shareable URL',
    base: `${scheme}://localhost:${port}`,
    shareable: false,
    reason: 'no Tailscale or LAN IPv4 interface is available on this machine',
  }
}

export function viewerLoginUrl(base, docName, token) {
  const redirect = docName ? `/?project=${docName}` : '/'
  return `${base.replace(/\/+$/, '')}/auth/login?token=${encodeURIComponent(token)}&redirect=${encodeURIComponent(redirect)}`
}
