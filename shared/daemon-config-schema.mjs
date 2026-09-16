import { parseDurationMs } from './inbox-attention.mjs'

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export const DAEMON_CONFIG_TOP_LEVEL_KEYS = Object.freeze([
  'machineId',
  'regions',
  'profiles',
  'grants',
  'models',
  'default',
  'tmuxSocket',
  'taskDoc',
  'spawnMachineId',
  'environments',
  // Read by getStatusScanMs(). This list is a CLOSED allow-list: the daemon
  // refuses to start on an unknown key, so a new setting is not usable until it
  // is named here. Adding the key to daemon.yaml without this line took the live
  // daemon down for 25 minutes on 2026-07-25 — it died on its next restart, with
  // a zero-byte log, so nothing pointed at the cause.
  'statusScanSeconds',
  'jsonlTailIdleSeconds',
  // Read by getMintRegistrationDeadlineMs().
  'mintRegistrationDeadlineSeconds',
  // Read by getSourceChangeSettleDeadlineMs().
  'sourceChangeSettleDeadlineSeconds',
  // Read by getOutboxInflightDeadlineMs().
  'outboxInflightDeadlineSeconds',
  // Read by getOutboxFlushByteBudget().
  'outboxFlushByteBudget',
  // Names (only names — never values) of operator-owned environment variables
  // `tlda config apply` renders into fleet-daemon launchd plists, with values
  // read from the applying process's own environment. Declared here so the
  // declaration is public and convergent while every value stays out of the
  // file (see config/environment-variables.md §2: secrets stay env vars).
  'launchdEnv',
  'terminalInputAllowed',
  // Named subscription sets, in the `{ default, values }` form `models:` and
  // `environments:` use. Additive only — an agent's reachability comes from the
  // floor in shared/subscriptions.mjs, not from here, so a machine without this
  // key (or without a daemon.yaml at all, which is the Fly server) still
  // notifies everyone.
  'subscriptions',
])

// Like DAEMON_CONFIG_TOP_LEVEL_KEYS, a CLOSED allow-list: the server refuses to
// start on an unknown key, so a new setting is not usable until it is named here.
export const SERVER_CONFIG_TOP_LEVEL_KEYS = Object.freeze([
  // What this deployment calls itself in the browser tab. Absent = "tlda", the
  // title baked into index.html at build time. It lives here rather than in the
  // built HTML because dist/ is one artifact every deployment serves, so a
  // deployment cannot have its own copy without that copy going stale on the
  // next build. The manifest's `name` is the same string for the installed web
  // app, and is a static file in that deployment's dist-overrides/ — two copies
  // of one name, which is worth knowing when you change either.
  'appName',
  'buildMaxConcurrency',
  'buildPriority',
  'buildStallTimeoutMs',
  // Which published projects are delivered, and to which environment:
  // `{ '<project>': '<environment>' }`. Absent -- the normal case -- means
  // nothing is delivered and publication behaves as it always has.
  //
  // Ships BEFORE any server.yaml names it: this list is closed, so a config
  // carrying the key is a hard startup failure on a tree that predates it.
  'previewDelivery',
  // Where this deployment's builds RUN. Absent — the normal case — means they
  // run here, forked by the server, which is what every deployment did before
  // this key existed. Present, it names a machine that renders instead:
  // `{ url, token, git: { url, daemonId, token } }`. The git credential is the
  // executor's own and should be a read-only one; it fetches revisions and must
  // not be able to move a head (see server/lib/git-http.mjs).
  //
  // It is a deployment setting rather than an environment variable because
  // which machine renders is a property of a deployment, and an unset
  // environment variable fails by silently building somewhere else — the
  // failure mode `deepgramBridgeUrl` is here to avoid.
  //
  // DEPLOYING THIS KEY IS COORDINATED, and the allowlist below is why. It is
  // CLOSED: an unknown top-level key throws, so a `server.yaml` carrying
  // `buildExecutor` is a HARD STARTUP FAILURE for anything running from a tree
  // that predates this line — not a degradation, not an ignored setting. And it
  // is not only the server: `cli/tlda.mjs` and `cli/lib/dev-worktree.mjs` also
  // call `loadServerConfig()`, so a CLI on the box from an older checkout dies
  // the same way.
  //
  // So the schema lands everywhere that reads `server.yaml` BEFORE the key
  // appears in one. This is the independent-deploy rule in `AGENTS.md` pointed
  // the additive way round; the three-stage recipe there covers removing a
  // field, and adding one has the opposite order.
  'buildExecutor',
  // The subscription slots every agent is minted with, and how loud each one
  // starts. Read by the server at mint. It belongs here rather than in
  // daemon.yaml because the server is not allowed to read daemon.yaml, and
  // minting happens on the server.
  'subscriptions',
  // How long the server waits for an agent's MCP to acknowledge a notification
  // before reporting the symptom to that agent's daemon. `{ ackTimeout: '5s' }`.
  // The one rule the notification path runs, and a server setting, so it lives
  // here rather than in a source constant or an environment variable.
  'notifications',
  // Optional server-owned email notification transport. Contact bindings stay
  // private here; roster and chat APIs expose only delivery state.
  'email',
  // IANA zone name (e.g. "America/New_York") that human-readable times render
  // in. DISPLAY ONLY — stored timestamps stay UTC. Read by getDisplayTimeZone()
  // in shared/display-time.mjs. Absent = render in the host machine's own zone.
  'timezone',
  'telemetryUrl',
  // How THIS SERVER reaches the one Deepgram bridge on the tlda-voice box, over
  // Fly's private 6PN (ws://tlda-voice.internal:8180). REQUIRED: when this was an
  // environment variable, leaving it unset did not fail — /api/voice/backends fell
  // through to "does this server hold a Deepgram key", so Deepgram silently
  // vanished from Skip's picker with no error anywhere.
  'deepgramBridgeUrl',
  // How THE BROWSER reaches that same bridge (the tailnet name,
  // wss://tlda-voice.<tailnet>.ts.net), handed to the client so its audio socket
  // does not terminate on this machine and therefore does not die when this
  // machine is deployed. Absent means the browser uses the same-origin proxy on
  // this server, which is the route that ships today.
  'deepgramDirectUrl',
  // Byte cap for the same-origin voice proxy's raw PCM queue while it is holding
  // browser audio before the upstream bridge opens.
  'deepgramProxyPcmBacklogMaxBytes',
  // Where uploaded and copied chat attachments live. On Fly this must name the
  // persistent volume; the container wipes anything else on restart, which once
  // wiped markdown-chip files out from under their chips. Absent = this machine's
  // ~/.config/tlda/uploads, which is correct where nothing is ephemeral.
  'uploadDir',
  // The one rule the notification path runs: no MCP ack within
  // notifications.ackTimeout -> report the symptom to that agent's daemon. It is
  // a server setting, so it lives here rather than in code or an environment
  // variable — see docs/notifications-and-liveness.md §"The timeout is
  // configuration, not code".
  //
  // THIS ENTRY IS LOAD-BEARING AND WAS MISSING THE FIRST TIME. Unknown top-level
  // keys throw in validateTopLevelKeys, and loadServerConfig() runs at module
  // scope in unified-server.mjs, so a deployment declaring `notifications:`
  // without this line does not misbehave — the server does not start at all.
  'notifications',
  // Turn token auth off entirely. True where the server is gated at the NETWORK
  // layer instead — the Fly boxes sit behind Tailscale, and the tailnet IS the
  // auth posture (Skip's chosen model).
  'tokenGating',
  // Take the read/RW tokens ONLY from the environment (`fly secrets`), never from
  // this machine's tokens.json, and refuse to start if neither is present. True on
  // a hosted deployment, where a token file on the box would be the wrong
  // authority and an absent one must not quietly disable auth.
  'tokensFromEnvironmentOnly',
])

export const PROJECT_DAEMON_OVERRIDE_TOP_LEVEL_KEYS = Object.freeze([
  'regions',
  'profiles',
  'grants',
  'models',
  'default',
])

export const STRICT_SERVER_FIELDS = Object.freeze([
  'database',
  'store',
  'licenseKey',
])

function validateTopLevelKeys(root, allowedKeys, label) {
  if (!isRecord(root)) {
    throw new Error(`${label} must be an object`)
  }
  const config = root
  const allowed = new Set(allowedKeys)
  const extra = Object.keys(config).filter(key => !allowed.has(key))
  if (extra.length) {
    throw new Error(`${label} supports only ${allowedKeys.join(', ')}; unknown key(s): ${extra.join(', ')}`)
  }
  return config
}

export function validateDaemonConfigTopLevel(root, label = 'daemon config') {
  const config = validateTopLevelKeys(root, DAEMON_CONFIG_TOP_LEVEL_KEYS, label)
  if (config.terminalInputAllowed !== undefined && typeof config.terminalInputAllowed !== 'boolean') {
    throw new Error(`${label}: "terminalInputAllowed" must be a boolean`)
  }
  validateDaemonSubscriptions(config.subscriptions, label)
  validateLaunchdEnv(config.launchdEnv, label)
  return config
}

// Names-only declaration of operator-owned env vars for fleet-daemon launchd
// plists. Fail-loud like everything else in this file: a misspelled,
// duplicated, or non-string entry is a declaration nobody is applying, and
// this subsystem's whole failure mode is silence.
export function validateLaunchdEnv(block, label = 'daemon config') {
  if (block === undefined) return []
  if (!Array.isArray(block)) {
    throw new Error(`${label}: "launchdEnv" must be a list of environment variable names`)
  }
  const seen = new Set()
  for (const name of block) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`${label}: "launchdEnv" entries must look like ENV_VAR_NAMES (got ${JSON.stringify(name)})`)
    }
    if (seen.has(name)) {
      throw new Error(`${label}: "launchdEnv" declares "${name}" twice`)
    }
    seen.add(name)
  }
  return [...seen]
}

// Same `{ default, values }` contract `models:` is held to, and the same errors,
// because it is the same notation. A set named as default that does not exist is
// rejected rather than ignored: a silently-dropped default is a delivery rule
// nobody is applying, and this subsystem's whole failure mode is silence.
export function validateDaemonSubscriptions(block, label = 'daemon config') {
  if (block === undefined) return
  if (!isRecord(block)) throw new Error(`${label}: "subscriptions" must be an object`)
  const extra = Object.keys(block).filter(k => k !== 'default' && k !== 'values')
  if (extra.length) throw new Error(`${label}: daemon subscriptions must use { default, values }; unknown key(s): ${extra.join(', ')}`)
  if (block.values !== undefined && !isRecord(block.values)) {
    throw new Error(`${label}: "subscriptions.values" must be an object`)
  }
  for (const [name, entries] of Object.entries(block.values || {})) {
    if (!Array.isArray(entries)) throw new Error(`${label}: subscription set "${name}" must be a list`)
    for (const entry of entries) {
      const query = typeof entry === 'string' ? entry : entry?.query
      if (typeof query !== 'string' || !query.length) {
        throw new Error(`${label}: subscription set "${name}" has an entry with no query`)
      }
    }
  }
  if (block.default === undefined) {
    if (block.values !== undefined) throw new Error(`${label}: "subscriptions.default" is required when subscriptions.values is configured`)
    return
  }
  if (typeof block.default !== 'string' || !(block.default in (block.values || {}))) {
    throw new Error(`${label}: subscriptions.default "${block.default}" is not in subscriptions.values`)
  }
}

export function validateProjectDaemonOverrideTopLevel(root, label = 'project daemon override') {
  return validateTopLevelKeys(root, PROJECT_DAEMON_OVERRIDE_TOP_LEVEL_KEYS, label)
}

export function validateServerConfigTopLevel(root, label = 'server config') {
  const config = validateTopLevelKeys(root, SERVER_CONFIG_TOP_LEVEL_KEYS, label)
  if (config.appName !== undefined && (typeof config.appName !== 'string' || !config.appName.trim())) {
    throw new Error(`${label}: "appName" must be a nonempty string`)
  }
  if (config.timezone !== undefined) validateTimeZone(config.timezone, label)
  if (config.telemetryUrl !== undefined) validateTelemetryUrl(config.telemetryUrl, label)
  if (config.deepgramBridgeUrl !== undefined) validateWebSocketUrl(config.deepgramBridgeUrl, 'deepgramBridgeUrl', label)
  if (config.deepgramDirectUrl !== undefined) validateWebSocketUrl(config.deepgramDirectUrl, 'deepgramDirectUrl', label)
  if (config.deepgramProxyPcmBacklogMaxBytes !== undefined) validatePositiveInteger(config.deepgramProxyPcmBacklogMaxBytes, 'deepgramProxyPcmBacklogMaxBytes', label)
  if (config.uploadDir !== undefined && (typeof config.uploadDir !== 'string' || !config.uploadDir.trim())) {
    throw new Error(`${label}: "uploadDir" must be a nonempty path`)
  }
  for (const key of ['tokenGating', 'tokensFromEnvironmentOnly']) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') {
      throw new Error(`${label}: "${key}" must be a boolean`)
    }
  }
  // Refused at load, for the same reason `subscriptions` is: a typo here makes
  // the server wait a length of time nobody chose before it reports a symptom,
  // and the unit rule is the whole point of the value — a bare `2` is an error,
  // not a default in some unit the reader has to guess. The grammar is checked
  // here rather than only at the point of use so a bad value cannot reach a
  // running server.
  if (config.notifications !== undefined) {
    if (!isRecord(config.notifications)) {
      throw new Error(`${label}: "notifications" must be an object, e.g. { ackTimeout: 2s }`)
    }
    const extra = Object.keys(config.notifications).filter(key => key !== 'ackTimeout')
    if (extra.length) {
      throw new Error(`${label}: notifications supports only ackTimeout; unknown key(s): ${extra.join(', ')}`)
    }
    const ackTimeout = config.notifications.ackTimeout
    if (ackTimeout !== undefined && !parseDurationMs(ackTimeout)) {
      throw new Error(`${label}: notifications.ackTimeout must be a duration WITH A UNIT (e.g. 2s, 250ms); got ${JSON.stringify(ackTimeout)}`)
    }
  }
  if (config.email !== undefined) {
    if (!isRecord(config.email)) throw new Error(`${label}: "email" must be an object`)
    const allowed = ['account', 'replyDomain', 'replySecretEnv', 'transport', 'inbound', 'identities']
    const extra = Object.keys(config.email).filter(key => !allowed.includes(key))
    if (extra.length) throw new Error(`${label}: email supports only ${allowed.join(', ')}; unknown key(s): ${extra.join(', ')}`)
    for (const key of ['account', 'replyDomain', 'replySecretEnv']) {
      if (typeof config.email[key] !== 'string' || !config.email[key].trim()) {
        throw new Error(`${label}: email.${key} must be a nonempty string`)
      }
    }
    if (!isRecord(config.email.transport)) throw new Error(`${label}: email.transport must be an object`)
    const transportAllowed = ['kind', 'host', 'port', 'secure', 'username', 'passwordEnv']
    const transportExtra = Object.keys(config.email.transport).filter(key => !transportAllowed.includes(key))
    if (transportExtra.length) throw new Error(`${label}: email.transport supports only ${transportAllowed.join(', ')}; unknown key(s): ${transportExtra.join(', ')}`)
    if (config.email.transport.kind !== 'smtp') throw new Error(`${label}: email.transport.kind must be "smtp"`)
    if (typeof config.email.transport.host !== 'string' || !config.email.transport.host.trim()) throw new Error(`${label}: email.transport.host must be a nonempty string`)
    validatePositiveInteger(config.email.transport.port, 'email.transport.port', label)
    if (config.email.transport.secure !== true) throw new Error(`${label}: email.transport.secure must be true`)
    for (const key of ['username', 'passwordEnv']) {
      if (typeof config.email.transport[key] !== 'string' || !config.email.transport[key].trim()) throw new Error(`${label}: email.transport.${key} must be a nonempty string`)
    }
    if (!isRecord(config.email.inbound)) throw new Error(`${label}: email.inbound must be an object`)
    const inboundAllowed = ['kind', 'host', 'port', 'secure', 'username', 'passwordEnv', 'pollInterval']
    const inboundExtra = Object.keys(config.email.inbound).filter(key => !inboundAllowed.includes(key))
    if (inboundExtra.length) throw new Error(`${label}: email.inbound supports only ${inboundAllowed.join(', ')}; unknown key(s): ${inboundExtra.join(', ')}`)
    if (config.email.inbound.kind !== 'imap') throw new Error(`${label}: email.inbound.kind must be "imap"`)
    if (typeof config.email.inbound.host !== 'string' || !config.email.inbound.host.trim()) throw new Error(`${label}: email.inbound.host must be a nonempty string`)
    validatePositiveInteger(config.email.inbound.port, 'email.inbound.port', label)
    if (config.email.inbound.secure !== true) throw new Error(`${label}: email.inbound.secure must be true`)
    for (const key of ['username', 'passwordEnv']) {
      if (typeof config.email.inbound[key] !== 'string' || !config.email.inbound[key].trim()) throw new Error(`${label}: email.inbound.${key} must be a nonempty string`)
    }
    if (!parseDurationMs(config.email.inbound.pollInterval)) throw new Error(`${label}: email.inbound.pollInterval must be a duration with a unit`)
    if (!isRecord(config.email.identities)) throw new Error(`${label}: email.identities must be a private identity-to-contact map`)
    for (const [identity, contact] of Object.entries(config.email.identities)) {
      if (!identity.startsWith('fleet:') || !isRecord(contact) || typeof contact.address !== 'string' || !contact.address.includes('@') || contact.verified !== true) {
        throw new Error(`${label}: email identity ${JSON.stringify(identity)} must be { address, verified: true }`)
      }
    }
  }
  // A malformed slot list is refused at load rather than at mint. An agent that
  // comes up with no subscriptions is silent — nothing wakes it and the sender
  // gets no receipt saying so — and that is the failure this key exists to
  // prevent, so it must not be reachable by a typo.
  if (config.subscriptions !== undefined) {
    if (!Array.isArray(config.subscriptions)) {
      throw new Error(`${label}: "subscriptions" must be a list of { query, policy }`)
    }
    for (const entry of config.subscriptions) {
      const query = typeof entry === 'string' ? entry : entry?.query
      if (typeof query !== 'string' || !query.trim()) {
        throw new Error(`${label}: every "subscriptions" entry needs a nonempty query`)
      }
    }
  }
  return config
}

function validatePositiveInteger(value, key, label = 'config') {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label}: "${key}" must be a positive integer`)
  }
}

/**
 * A bridge address that is a string but not a WebSocket URL fails at the first
 * connect attempt, which is mid-sentence for whoever is dictating. Ask at load.
 */
export function validateWebSocketUrl(value, key, label = 'server config') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label}: "${key}" must be a nonempty ws(s) URL`)
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label}: "${key}" must be a valid ws(s) URL (got ${value})`)
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`${label}: "${key}" must use ws or wss (got ${value})`)
  }
  return url.toString()
}

export function validateTelemetryUrl(value, label = 'server config') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label}: "telemetryUrl" must be a nonempty http(s) URL`)
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label}: "telemetryUrl" must be a valid http(s) URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label}: "telemetryUrl" must use http or https`)
  }
  return url.toString()
}

/**
 * A bad zone name must fail at config load, not silently at the first render.
 * Intl is the authority on what names exist, so ask it rather than keeping a
 * list here that would rot.
 */
export function validateTimeZone(value, label = 'server config') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label}: "timezone" must be a nonempty IANA zone name, e.g. America/New_York`)
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
  } catch {
    throw new Error(`${label}: "timezone" is not a zone this system knows: ${value} (expected an IANA name like America/New_York)`)
  }
  return value
}

export function validateStrictEnvironments(environments, label = 'daemon.yaml environments') {
  if (!isRecord(environments)) {
    throw new Error(`${label} must be an object with default and values`)
  }
  const extraTop = Object.keys(environments).filter(key => key !== 'default' && key !== 'values')
  if (extraTop.length) {
    throw new Error(`${label} supports only default, values; unknown key(s): ${extraTop.join(', ')}`)
  }
  if (typeof environments.default !== 'string' || !environments.default.trim()) {
    throw new Error('tlda config: "environments.default" must be a nonempty string in daemon.yaml')
  }
  if (!isRecord(environments.values)) {
    throw new Error(`${label}.values must be an object of named environment entries`)
  }
  const allowed = new Set([...STRICT_SERVER_FIELDS, 'runtimeRoot'])
  for (const [name, raw] of Object.entries(environments.values)) {
    if (!isRecord(raw)) {
      throw new Error(`tlda environment "${name}" must be an object in ${label}.values`)
    }
    const extra = Object.keys(raw).filter(key => !allowed.has(key))
    if (extra.length) {
      throw new Error(`tlda environment "${name}" supports only ${[...allowed].join(', ')}; unknown key(s): ${extra.join(', ')}`)
    }
    for (const field of STRICT_SERVER_FIELDS) {
      if (typeof raw[field] !== 'string') {
        throw new Error(`tlda environment "${name}": "${field}" must be a string in ${label}.${name} — declare database, store, and licenseKey explicitly (no url/database-as-store/top-level-license fallback).`)
      }
    }
    // Optional: where this environment's local runtime lives. Absent means the
    // tree the process was loaded from (module location) — the standing
    // behavior non-developer boxes keep. When declared it must be absolute;
    // the daemon refuses to start from anywhere else.
    if (raw.runtimeRoot !== undefined && !isAbsoluteRoot(raw.runtimeRoot)) {
      throw new Error(`tlda environment "${name}": "runtimeRoot" must be an absolute path in ${label}.${name}, got ${JSON.stringify(raw.runtimeRoot)}`)
    }
  }
  return environments.values
}

export function resolveStrictEnvironmentAuthority(root, envName = null) {
  const config = validateDaemonConfigTopLevel(root, 'daemon config')
  if (envName !== null && typeof envName !== 'string') {
    throw new TypeError('tlda config: environment name override must be a string')
  }
  const environments = validateStrictEnvironments(config.environments)
  const fallbackName = config.environments.default.trim()
  if (!environments[fallbackName]) {
    throw new Error(`tlda config: no environment named "${fallbackName}" in daemon.yaml environments — known: ${Object.keys(environments).join(', ') || '(none)'}`)
  }
  const name = envName || process.env.TLDA_ENV || fallbackName
  if (!name) throw new Error('tlda config: no active environment — set "environments.default" in daemon.yaml (or TLDA_ENV)')
  const raw = environments[name]
  if (!raw) throw new Error(`tlda config: no environment named "${name}" in daemon.yaml environments — known: ${Object.keys(environments).join(', ') || '(none)'}`)
  return { name, raw }
}
