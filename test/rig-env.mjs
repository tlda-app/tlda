import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function candidatePaths({ rig, cwd = process.cwd(), home = homedir(), env = process.env } = {}) {
  const paths = []
  if (rig && rig !== true) paths.push(String(rig))
  if (env.TLDA_RIG_JSON) paths.push(env.TLDA_RIG_JSON)
  paths.push(join(cwd, '.tlda-dev', 'rig.json'))
  paths.push(join(home, '.config', 'tlda', 'dev-server', 'rig.json'))
  return paths
}

export function loadRigManifest(options = {}) {
  for (const path of candidatePaths(options)) {
    const full = resolve(path)
    if (!existsSync(full)) continue
    return { path: full, manifest: readJson(full) }
  }
  return null
}

function cleanBase(url) {
  return typeof url === 'string' ? url.replace(/\/+$/, '') : null
}

export function resolveRigEnv(options = {}) {
  const loaded = loadRigManifest(options)
  const manifest = loaded?.manifest || null
  const viewer = cleanBase(manifest?.viewer) || null
  const backend = cleanBase(manifest?.backend) || null
  return {
    manifestPath: loaded?.path || null,
    manifest,
    viewer,
    backend,
    doc: options.doc || manifest?.doc || 'bregman',
    token: manifest?.noAuth ? '' : (options.token || manifest?.token || ''),
    noAuth: !!manifest?.noAuth,
    isolated: !!manifest?.isolated,
  }
}
