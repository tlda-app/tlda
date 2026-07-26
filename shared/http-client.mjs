/**
 * Shared HTTP client for talking to the tlda server.
 *
 * One function, one error model, one auth pattern. Every consumer
 * (CLI, MCP server, fleet MCP, daemon) uses this instead of rolling
 * its own fetch wrapper.
 */

import { getServerUrl, getRwToken } from './config.mjs'

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Make an HTTP request to the tlda server.
 *
 * @param {string} path      — URL path (e.g. '/api/projects/foo/build')
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {object|string} [options.body]  — auto-stringified if object
 * @param {object} [options.headers]      — merged with auth + content-type
 * @param {number} [options.timeoutMs=10000]
 * @param {string} [options.server]       — override server URL
 * @param {string} [options.environmentName] — selected tlda environment name for errors
 * @param {string} [options.token]        — override auth token
 * @param {boolean} [options.raw=false]   — return Response instead of parsed JSON
 * @returns {Promise<any>}  parsed JSON response (or raw Response if options.raw)
 * @throws {Error} on timeout, network error, or non-ok status
 */
export async function tldaFetch(path, options = {}) {
  const {
    method = 'GET',
    body = null,
    headers: extraHeaders = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    server = getServerUrl(),
    environmentName = null,
    token = getRwToken(),
    raw = false,
  } = options

  const url = `${server}${path}`
  const headers = { ...extraHeaders }
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'

  const fetchOpts = { method, headers, signal: AbortSignal.timeout(timeoutMs) }
  if (body) fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body)

  let res
  try {
    res = await fetch(url, fetchOpts)
  } catch (e) {
    const env = environmentName ? ` for environment "${environmentName}"` : ''
    if (e.name === 'TimeoutError') throw new Error(`Request timed out${env} at ${server}: ${method} ${path}`)
    throw new Error(`Server not reachable${env} at ${server} (${e.cause?.code || e.message})`)
  }

  if (raw) return res

  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }

  if (!res.ok) {
    const msg = typeof data === 'object' ? data?.error || text : text
    const err = new Error(msg || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }

  return data
}
