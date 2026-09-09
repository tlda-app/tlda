import { readFileSync, writeFileSync } from 'node:fs'

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

let url
try {
  url = new URL(value)
} catch {
  throw new Error('TLDA_PROMOTION_SOURCE_URL must be a valid HTTPS origin')
}
if (
  url.protocol !== 'https:' ||
  url.username ||
  url.password ||
  url.pathname !== '/' ||
  url.search ||
  url.hash ||
  url.origin !== value
) {
  throw new Error('TLDA_PROMOTION_SOURCE_URL must be a valid HTTPS origin')
}

writeFileSync(daemonPath, source.replaceAll(SENTINEL, value))
