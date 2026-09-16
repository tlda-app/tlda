// Convergent env secrets for `tlda config apply`.
//
// The design: env var NAMES are declared in daemon.yaml (`launchdEnv`, names
// only — that file is public, values never go there). At apply time the VALUES
// are read from the applying process's own environment, and apply renders
// template entries plus those vars into the fleet-daemon plist. Same config
// plus same environment gives the same plist on every run; anything already in
// the plist that is NOT declared is dropped, because the generator owns the
// whole file.
//
// All functions are pure (the process env is an explicit parameter, defaulting
// to process.env at the call site) so the convergence property is testable
// without touching a plist, a daemon, or the live config.

export function declaredLaunchdEnvNames(daemonConfig) {
  const names = daemonConfig?.launchdEnv
  if (names === undefined) return []
  // daemon.yaml validation (validateLaunchdEnv) owns the shape; this is the
  // backstop for callers that hand-built the config object.
  if (!Array.isArray(names)) {
    throw new Error('"launchdEnv" must be a list of environment variable names')
  }
  return names
}

// Resolve declared names against an environment snapshot. Declared-but-missing
// names are collected, not thrown: apply warns visibly and continues the other
// jobs. A declared name colliding with a key the plist template already sets
// IS thrown: two writers for one key cannot converge, so the declaration must
// drop the name.
export function resolveLaunchdEnv(names, { env = process.env, reserved = [] } = {}) {
  const reservedSet = new Set(reserved)
  const entries = []
  const missing = []
  for (const name of names) {
    if (reservedSet.has(name)) {
      throw new Error(`"launchdEnv" declares "${name}", which the plist template already sets — remove it from the declaration`)
    }
    const value = env[name]
    if (value === undefined) missing.push(name)
    else entries.push([name, String(value)])
  }
  return { entries, missing }
}

export function escapePlistString(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function renderEnvironmentPlist(entries) {
  return entries
    .map(([key, value]) => `        <key>${escapePlistString(key)}</key>\n        <string>${escapePlistString(value)}</string>`)
    .join('\n')
}

// The missing-var warning names the var and never carries a value: this
// function only ever receives names, so a value cannot leak through it.
export function formatMissingLaunchdEnvWarning(missing) {
  const names = missing.map(name => `"${name}"`).join(', ')
  const pronoun = missing.length === 1 ? 'it' : 'them'
  return `tlda config apply: this environment provides no value for ${names} — leaving ${pronoun} out of the plist`
}
