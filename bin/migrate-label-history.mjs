#!/usr/bin/env node

import { resolve } from 'node:path'
import { FleetStore } from '../server/lib/fleet-store.mjs'

const dbPath = process.argv[2]
if (!dbPath) {
  console.error('usage: node bin/migrate-label-history.mjs /path/to/fleet.db')
  process.exitCode = 2
} else {
  const store = new FleetStore(resolve(dbPath), { taskDoc: false })
  try {
    const migrated = store.migrateExistingAgentLabelsToEvents()
    console.log(JSON.stringify(migrated))
  } finally {
    store.close()
  }
}
