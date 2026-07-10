import fs from 'fs'
import path from 'path'
import { repoRoot } from '../identity.mjs'

const SOURCE_PRELOAD = path.join(repoRoot(), 'shared', 'node-dns-alias.cjs')
const RUNTIME_PRELOAD_DIR = '/tmp/tlda-fence-env'
const RUNTIME_PRELOAD = path.join(RUNTIME_PRELOAD_DIR, 'node-dns-alias.cjs')

export function dnsAliasPreloadPath() {
  if (!fs.existsSync(SOURCE_PRELOAD)) return null
  try {
    fs.mkdirSync(RUNTIME_PRELOAD_DIR, { recursive: true })
    fs.copyFileSync(SOURCE_PRELOAD, RUNTIME_PRELOAD)
    return RUNTIME_PRELOAD
  } catch {
    return SOURCE_PRELOAD
  }
}
