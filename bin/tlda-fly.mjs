#!/usr/bin/env node
import { runFlyCli } from '../cli/lib/fly/router.mjs'

runFlyCli(process.argv.slice(2)).catch((e) => {
  console.error(`Error: ${e.message}`)
  process.exit(1)
})
