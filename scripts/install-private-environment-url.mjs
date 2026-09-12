import { readFileSync, writeFileSync } from 'node:fs'
import { validatePromotionSourceOrigin } from '../server/lib/promotion-source.mjs'

const SENTINEL = '__TLDA_PROMOTION_SOURCE_URL__'
const [daemonPath] = process.argv.slice(2)

if (!daemonPath) throw new Error('daemon config path is required')

const source = readFileSync(daemonPath, 'utf8')
const occurrences = source.split(SENTINEL).length - 1

if (occurrences === 0) process.exit(0)
if (occurrences !== 2) {
  throw new Error('deployment config must use the private environment URL sentinel exactly twice')
}

const value = process.env.TLDA_PROMOTION_SOURCE_URL
if (!value) throw new Error('TLDA_PROMOTION_SOURCE_URL is required by this deployment config')

try {
  const origin = validatePromotionSourceOrigin(value)
  if (origin !== value) throw new Error('noncanonical promotion source origin')
} catch {
  throw new Error('TLDA_PROMOTION_SOURCE_URL must be a valid promotion source origin')
}

writeFileSync(daemonPath, source.replaceAll(SENTINEL, value))
