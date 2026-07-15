import fs from 'fs'
import path from 'path'
import { activeConfigName, gitAuthorEnv, readConfig } from '../identity.mjs'
import { resolveClaudeModel, resolveClaudeModelSelection } from '../models.mjs'
import { resolveHarnessLaunchOptions } from '../permissions.mjs'
import { dnsAliasPreloadPath } from './dns-alias-preload.mjs'

const LOGIN_PROMPT = 'Call login() with the fleet MCP server. Then call inbox() to check for a pending task.'
const FENCE_TMP_ROOT = '/tmp/tlda-fence-env'

function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function appendLaunchFlags(parts, harnessOptions = {}) {
  for (const flag of [...(harnessOptions.required || []), ...(harnessOptions.preferences || [])]) {
    if (typeof flag !== 'string' || !flag.trim()) continue
    if (!parts.includes(flag)) parts.push(flag)
  }
}

export function loginPrompt() {
  return LOGIN_PROMPT
}

export function resolveModel(model, options = {}) {
  return resolveClaudeModel(model, options)
}

export function resolveModelSelection(model, options = {}) {
  return resolveClaudeModelSelection(model, options)
}

export function buildCmd({
  fleetId,
  localAgentId,
  tmuxSession,
  model,
  effort,
  name,
  api,
  dnsAlias = null,
  resumeId = null,
  includePrompt = true,
  env = process.env,
  config = readConfig(),
  harnessOptions = null,
} = {}) {
  const effectiveHarnessOptions = harnessOptions && Object.keys(harnessOptions).length
    ? harnessOptions
    : resolveHarnessLaunchOptions({ config, harness: 'claude', model })
  const parts = [
    ...(fleetId ? [`FLEET_ID=${sq(fleetId)}`] : []),
    ...(localAgentId ? [`FLEET_LOCAL_ID=${sq(localAgentId)}`] : []),
    `FLEET_TMUX_SESSION=${sq(tmuxSession)}`,
    'FLEET_HARNESS=claude',
  ]
  // Fresh spawn names can still be tentative before server confirm/rename;
  // GIT_AUTHOR_EMAIL carries the stable fleet id for authoritative attribution.
  parts.push(...gitAuthorEnv(fleetId || localAgentId, name).map(v => sqEnv(v)))
  const readableLocalCert = path.join(process.env.HOME || '', '.config', 'tlda', 'localhost+2.pem')
  if (fs.existsSync(readableLocalCert)) {
    const fenceCert = path.join(FENCE_TMP_ROOT, 'localhost-ca.crt')
    try {
      fs.mkdirSync(FENCE_TMP_ROOT, { recursive: true })
      fs.copyFileSync(readableLocalCert, fenceCert)
      parts.push(`NODE_EXTRA_CA_CERTS=${sq(fenceCert)}`)
    } catch {
      // The fence may deliberately deny *.pem secrets. TLS validation is already
      // disabled for this local/tailscale dev path below, so do not point Node
      // at an unreadable cert and turn startup into an EPERM loop.
    }
  }
  parts.push('NODE_TLS_REJECT_UNAUTHORIZED=0')
  if (name) parts.push(`FLEET_NAME=${sq(name)}`)
  if (env.TLDA_MACHINE_ID) parts.push(`TLDA_MACHINE_ID=${sq(env.TLDA_MACHINE_ID)}`)
  const configName = activeConfigName(config, env)
  if (configName) parts.push(`TLDA_CONFIG=${sq(configName)}`)
  if (api) {
    parts.push(`TLDA_SERVER=${sq(api)}`)
    parts.push(`TLDA_SYNC_SERVER=${sq(api)}`)
  }
  const fleetOauthToken = path.join(env.HOME || process.env.HOME || '', '.claude', '.fleet-oauth-token')
  if (fs.existsSync(fleetOauthToken)) {
    parts.push(`CLAUDE_CODE_OAUTH_TOKEN=$(cat ${sq(fleetOauthToken)})`)
  }
  const dnsAliasPreload = dnsAlias ? dnsAliasPreloadPath() : null
  if (dnsAlias && dnsAliasPreload) {
    parts.push(`NODE_OPTIONS=${sq(`--require=${dnsAliasPreload}`)}`)
    parts.push(`TLDA_NODE_DNS_ALIAS_HOST=${sq(dnsAlias.host)}`)
    parts.push(`TLDA_NODE_DNS_ALIAS_ADDR=${sq(dnsAlias.address)}`)
  }
  parts.push('claude')
  appendLaunchFlags(parts, effectiveHarnessOptions)
  if (resumeId) parts.push(`--resume ${sq(resumeId)}`)
  parts.push(`--model ${sq(model)}`)
  if (effort) parts.push(`--effort ${sq(effort)}`)
  // Permission flags (--dangerously-skip-permissions / --permission-mode) are NOT
  // derived here; they come from the configured harness options via appendLaunchFlags
  // above, exactly like the codex sandbox flag. The fence (region-set lease) is the
  // security; the classifier flag is the operator's configured choice.
  if (includePrompt) parts.push(sq(loginPrompt()))
  return parts.join(' ')
}

function sqEnv(entry) {
  const [key, ...rest] = String(entry).split('=')
  return `${key}=${sq(rest.join('='))}`
}

export function resumeId(handle) {
  return handle?.sessionId || null
}

export function kickoffPrompt(name) {
  return loginPrompt()
}
