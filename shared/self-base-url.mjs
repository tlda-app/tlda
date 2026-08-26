/**
 * The URL the server uses to reach ITSELF — the source-room git remote, and
 * nothing else.
 *
 * Loopback is wrong under TLS and cannot be made right locally. The listener's
 * SNI callback answers `localhost`/`127.0.0.1`/`::1` with the mkcert developer
 * cert and every other name with the tailnet cert, on purpose. git's CA store
 * has Let's Encrypt and does not have the mkcert root, so a self-push aimed at
 * loopback dies on `unable to get local issuer certificate` — measured on two
 * separate previews.
 *
 * So a preview hands over the cert-valid URL it already computed. Everything
 * else keeps loopback, which is correct for plain HTTP and is what a server
 * that was told nothing should assume.
 */
export function selfBaseUrl({ supplied = null, useTls = false, port } = {}) {
  const explicit = typeof supplied === 'string' ? supplied.trim() : ''
  if (explicit) return explicit.replace(/\/+$/, '')
  return `${useTls ? 'https' : 'http'}://127.0.0.1:${port}`
}
