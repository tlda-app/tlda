/**
 * Resolve CTD auth token.
 *
 * Priority: CTD_TOKEN env → tokenRw from ~/.config/ctd/config.json → null
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

let resolved = undefined

export function resolveToken() {
  if (resolved !== undefined) return resolved

  resolved = process.env.CTD_TOKEN || null
  if (resolved) return resolved

  try {
    const configPath = join(homedir(), '.config', 'ctd', 'config.json')
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      resolved = config.tokenRw || config.token || null
    }
  } catch {}

  return resolved
}
