#!/usr/bin/env node
/**
 * Export diff triage state from Yjs as a formatted report.
 *
 * Usage: node scripts/export-triage.mjs <doc-name> [sync-url]
 *
 * Reads signal:diff-review and signal:diff-summaries from the Yjs room,
 * prints a checklist grouped by decision status.
 */

import { WebSocket } from 'ws'
import * as Y from 'yjs'

const docName = process.argv[2]
if (!docName) {
  console.error('Usage: node scripts/export-triage.mjs <doc-name> [sync-url]')
  process.exit(1)
}

const syncUrl = process.argv[3] || 'ws://localhost:5176'
const roomId = `doc-${docName}`

const doc = new Y.Doc()
const yRecords = doc.getMap('tldraw')

const ws = new WebSocket(`${syncUrl}/${roomId}`)

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString())
    if (msg.type === 'sync' || msg.type === 'update') {
      Y.applyUpdate(doc, new Uint8Array(msg.data), 'remote')
    }
  } catch {}
})

ws.on('open', () => {
  // Wait for initial sync
  setTimeout(() => {
    const reviewSignal = yRecords.get('signal:diff-review')
    const summarySignal = yRecords.get('signal:diff-summaries')

    const reviews = reviewSignal?.reviews || {}
    const summaries = summarySignal?.summaries || {}

    const pages = Object.keys(reviews).map(Number).sort((a, b) => a - b)
    const allPages = new Set([...Object.keys(reviews), ...Object.keys(summaries)].map(Number))
    const sortedAll = [...allPages].sort((a, b) => a - b)

    if (sortedAll.length === 0) {
      console.log('No triage decisions found.')
      ws.close()
      process.exit(0)
    }

    const keepNew = []
    const revert = []
    const discuss = []
    const pending = []

    for (const p of sortedAll) {
      const status = reviews[p] || null
      const summary = summaries[p] || ''
      const entry = `p.${p}${summary ? ` — ${summary.replace(/\n/g, '; ')}` : ''}`

      if (status === 'new') keepNew.push(entry)
      else if (status === 'old') revert.push(entry)
      else if (status === 'discuss') discuss.push(entry)
      else pending.push(entry)
    }

    console.log(`# Diff Triage: ${docName}`)
    console.log(`# ${new Date().toISOString().slice(0, 10)}`)
    console.log()

    if (keepNew.length > 0) {
      console.log(`## Keep new (${keepNew.length})`)
      keepNew.forEach(e => console.log(`  [x] ${e}`))
      console.log()
    }

    if (revert.length > 0) {
      console.log(`## Revert (${revert.length})`)
      revert.forEach(e => console.log(`  [ ] ${e}`))
      console.log()
    }

    if (discuss.length > 0) {
      console.log(`## Discuss (${discuss.length})`)
      discuss.forEach(e => console.log(`  ? ${e}`))
      console.log()
    }

    if (pending.length > 0) {
      console.log(`## Pending (${pending.length})`)
      pending.forEach(e => console.log(`  - ${e}`))
      console.log()
    }

    const total = sortedAll.length
    const decided = keepNew.length + revert.length
    console.log(`---`)
    console.log(`${decided}/${total} decided, ${discuss.length} to discuss, ${pending.length} pending`)

    ws.close()
    process.exit(0)
  }, 1500)
})

ws.on('error', (e) => {
  console.error(`Connection failed: ${e.message}`)
  process.exit(1)
})
