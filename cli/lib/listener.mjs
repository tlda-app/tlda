#!/usr/bin/env node
/**
 * tlda listen <doc> — block until feedback arrives, print it as JSON, exit.
 *
 * Designed to be run via `bash(run_in_background)` so an agent can keep
 * working while waiting for annotations, pings, or drawn shapes.
 *
 * Connects to the server's SSE streams (signal + shape change), snapshots
 * existing shapes for diffing, and exits on the first meaningful event.
 *
 * Output: one JSON object to stdout, then exit 0.
 * On timeout: exit 1 with no output.
 */

import { connectSSE } from '../../shared/sse-parser.mjs'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// --- Config / auth ---

function loadConfig() {
  const f = join(homedir(), '.config', 'tlda', 'config.json')
  if (!existsSync(f)) return {}
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return {} }
}

const config = loadConfig()
const serverUrl = process.env.TLDA_SERVER || config.server || 'http://localhost:5176'
const token = process.env.TLDA_TOKEN || config.tokenRw || config.token || null
const authHeaders = token ? { 'Authorization': `Bearer ${token}` } : {}

// --- HTTP helpers ---

async function fetchJson(urlPath) {
  const url = `${serverUrl}${urlPath}`
  const res = await fetch(url, { headers: authHeaders })
  if (!res.ok) throw new Error(`${urlPath} → ${res.status}`)
  return res.json()
}

// --- SSE stream helpers ---

function connectSignalStream(docName, onSignal) {
  const stream = connectSSE({
    url: `${serverUrl}/api/projects/${docName}/signal/stream`,
    headers: authHeaders,
    onEvent: onSignal,
    onEnd() { setTimeout(() => stream.reconnect(), 3000) },
    onError() { setTimeout(() => stream.reconnect(), 5000) },
  })
  return stream
}

function connectShapeStream(docName, onChange) {
  const stream = connectSSE({
    url: `${serverUrl}/api/projects/${docName}/shapes/stream`,
    headers: authHeaders,
    onEvent: onChange,
    onEnd() { setTimeout(() => stream.reconnect(), 3000) },
    onError() { setTimeout(() => stream.reconnect(), 5000) },
  })
  return stream
}

// --- Main ---

export async function listen(docName, { timeout = 300 } = {}) {
  const timeoutMs = timeout * 1000
  const DEBOUNCE_MS = 5000

  // Snapshot existing shapes for diffing
  const knownShapes = new Map()
  try {
    const allShapes = await fetchJson(`/api/projects/${docName}/shapes`)
    for (const s of allShapes) {
      if (s.typeName === 'shape') knownShapes.set(s.id, s)
    }
  } catch (e) {
    console.error(`[listen] Warning: couldn't snapshot shapes: ${e.message}`)
  }

  // Track last ping so we don't fire on stale ones
  let lastPingTs = 0
  try {
    const existing = await fetchJson(`/api/projects/${docName}/signal/signal:ping`)
    if (existing?.timestamp) lastPingTs = existing.timestamp
  } catch {}

  return new Promise((resolve, reject) => {
    let debounceTimer = null
    let resolved = false
    let signalStream, shapeStream

    function cleanup() {
      if (debounceTimer) clearTimeout(debounceTimer)
      signalStream?.close()
      shapeStream?.close()
    }

    function done(result) {
      if (resolved) return
      resolved = true
      cleanup()
      resolve(result)
    }

    // --- Signals: ping, text-selection ---
    signalStream = connectSignalStream(docName, (signal) => {
      if (resolved) return

      if (signal.key === 'signal:ping' && signal.timestamp > lastPingTs) {
        lastPingTs = signal.timestamp
        done({ type: 'ping', doc: docName, ...signal })
        return
      }

      if (signal.key === 'signal:text-selection' && signal.text) {
        if (debounceTimer) clearTimeout(debounceTimer)
        const result = { type: 'text-selection', doc: docName, page: signal.page, text: signal.text }
        debounceTimer = setTimeout(() => done(result), 2000)
        return
      }
    })

    // --- Shape changes ---
    shapeStream = connectShapeStream(docName, async () => {
      if (resolved) return
      if (debounceTimer) clearTimeout(debounceTimer)

      debounceTimer = setTimeout(async () => {
        if (resolved) return
        try {
          const currentShapes = await fetchJson(`/api/projects/${docName}/shapes`)
          for (const record of currentShapes) {
            if (record.typeName !== 'shape') continue
            const known = knownShapes.get(record.id)

            if (!known) {
              // New shape
              knownShapes.set(record.id, record)

              if (record.type === 'math-note') {
                const choices = record.props?.choices
                const sel = record.props?.selectedChoice
                if (choices?.length && sel != null && sel >= 0) {
                  done({ type: 'choice', doc: docName, id: record.id,
                    choiceIndex: sel, choiceText: choices[sel],
                    question: record.props?.text || '',
                    anchor: record.meta?.sourceAnchor || null })
                  return
                }
                const text = record.props?.text || ''
                // Skip agent-authored notes
                if (text.trimEnd().endsWith('—Claude:') || text.trimEnd().endsWith('—Todd')) continue
                done({ type: 'annotation', doc: docName, action: 'add', id: record.id,
                  text, anchor: record.meta?.sourceAnchor || null })
                return
              }

              if (['draw', 'highlight', 'arrow', 'geo', 'text', 'line'].includes(record.type)) {
                done({ type: 'stroke', doc: docName, action: 'add', id: record.id,
                  shapeType: record.type,
                  x: record.x, y: record.y })
                return
              }
            } else {
              // Updated shape
              const oldJson = JSON.stringify(known.props)
              const newJson = JSON.stringify(record.props)
              if (oldJson !== newJson) {
                knownShapes.set(record.id, record)
                if (record.type === 'math-note') {
                  const choices = record.props?.choices
                  const sel = record.props?.selectedChoice
                  if (choices?.length && sel != null && sel >= 0 && sel !== known.props?.selectedChoice) {
                    done({ type: 'choice', doc: docName, id: record.id,
                      choiceIndex: sel, choiceText: choices[sel],
                      question: record.props?.text || '',
                      anchor: record.meta?.sourceAnchor || null })
                    return
                  }
                  const text = record.props?.text || ''
                  if (text.trimEnd().endsWith('—Claude:') || text.trimEnd().endsWith('—Todd')) continue
                  done({ type: 'annotation', doc: docName, action: 'update', id: record.id,
                    text, anchor: record.meta?.sourceAnchor || null })
                  return
                }
              }
            }
          }
        } catch (e) {
          console.error(`[listen] Shape diff error: ${e.message}`)
        }
      }, DEBOUNCE_MS)
    })

    // Timeout
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        cleanup()
        reject(new Error('timeout'))
      }
    }, timeoutMs)
  })
}

// --- CLI entry point ---

const isMain = process.argv[1] && (
  process.argv[1].endsWith('listener.mjs') ||
  process.argv[1].endsWith('listener')
)

if (isMain) {
  const doc = process.argv[2]
  if (!doc) {
    console.error('Usage: tlda listen <doc> [--timeout <seconds>]')
    process.exit(1)
  }
  const timeoutIdx = process.argv.indexOf('--timeout')
  const timeout = timeoutIdx >= 0 ? parseInt(process.argv[timeoutIdx + 1]) || 300 : 300

  try {
    const result = await listen(doc, { timeout })
    console.log(JSON.stringify(result))
  } catch (e) {
    if (e.message === 'timeout') {
      console.error(`[listen] No feedback within ${timeout}s`)
      process.exit(1)
    }
    console.error(`[listen] Error: ${e.message}`)
    process.exit(1)
  }
}
