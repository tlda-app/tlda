import { readFileSync, writeFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { validatePromotionSourceOrigin } from '../server/lib/promotion-source.mjs'

const SENTINEL = '__TLDA_PROMOTION_SOURCE_URL__'
const [daemonPath, serverPath] = process.argv.slice(2)

if (!daemonPath) throw new Error('daemon config path is required')

installPromotionSourceUrl(daemonPath)
if (serverPath) installPreviewDelivery(serverPath)

function installPromotionSourceUrl(path) {
  const source = readFileSync(path, 'utf8')
  const occurrences = source.split(SENTINEL).length - 1

  if (occurrences === 0) return
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

  writeFileSync(path, source.replaceAll(SENTINEL, value))
}

/**
 * Install the deployment's `previewDelivery` map into server.yaml.
 *
 * Project names are deployment-owned and must not sit in a public example, and
 * server.yaml is copied verbatim from the image at boot, so a map written into
 * the running config by hand is erased on the next boot. This puts it back from
 * the environment, as the sentinel above does for daemon.yaml.
 *
 * ABSENT MEANS NO MAPPING, and that is the safe direction: a project absent
 * from the map is never delivered, so an unset variable delivers nothing rather
 * than delivering somewhere unintended. An empty string and an empty object are
 * both treated as absent.
 *
 * JSON rather than a sentinel because a map has no fixed shape: it is a set of
 * pairs, not one string in a known place.
 */
function installPreviewDelivery(path) {
  const raw = process.env.TLDA_PREVIEW_DELIVERY
  if (raw === undefined || raw === '') return

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('TLDA_PREVIEW_DELIVERY must be JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TLDA_PREVIEW_DELIVERY must be a JSON object mapping project name to environment')
  }
  for (const [project, environment] of Object.entries(parsed)) {
    if (typeof environment !== 'string' || !environment) {
      throw new Error(`TLDA_PREVIEW_DELIVERY["${project}"] must be a non-empty string`)
    }
  }
  // An empty object is a map with nothing in it, which is what no mapping means.
  // Writing `previewDelivery:` with no entries would emit YAML null, not an
  // empty map, and the reader would see a key of the wrong type.
  if (Object.keys(parsed).length === 0) return

  const config = readFileSync(path, 'utf8')
  // Parsed, not matched. A quoted key, or a space before the colon, is the same
  // key to a reader and invisible to a regex.
  const existing = parseYaml(config) || {}
  if (Object.prototype.hasOwnProperty.call(existing, 'previewDelivery')) {
    throw new Error('server.yaml already declares previewDelivery; the deployment cannot also supply it')
  }

  const body = Object.entries(parsed)
    .map(([project, environment]) => `  ${JSON.stringify(project)}: ${JSON.stringify(environment)}`)
    .join('\n')
  const separator = config.endsWith('\n') ? '' : '\n'
  writeFileSync(path, `${config}${separator}\npreviewDelivery:\n${body}\n`)
}
