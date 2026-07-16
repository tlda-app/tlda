import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const PRODUCTION_DIRS = ['agent-launch', 'bin', 'cli', 'mcp-server', 'server', 'shared']
const SKIP_DIRS = new Set(['node_modules', '.git'])

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* files(full)
    else if (entry.isFile() && /\.(mjs|js|ts|tsx)$/.test(entry.name)) yield full
  }
}

const forbidden = [
  /\bpermissionClass\b/,
  /\bpermission_class\b/,
  /\bgrantedPermission\b/,
  /\bgrantedPermissions\b/,
  /\bgrantedPermissionSet\b/,
  /\brequestedPermission\b/,
  /\brequestedPermissions\b/,
  /\bregionPolicyFromSet\b/,
  /\bderivedPolicyFromRegionSet\b/,
  /\bpolicyForPermissionSet\b/,
  /\bremoteGrants\b/,
  /\bresolveRemoteDaemonGrant\b/,
  /\bspawnPolicy\s*\.\s*name\b/,
  /\bspawnPolicy\s*\?\.\s*name\b/,
  /\bspawnPolicy\s*\.\s*permission\b/,
  /\bspawnPolicy\s*\?\.\s*permission\b/,
  /projectedPolicy\s*:\s*\{\s*name\s*:/,
]

test('production code has one permission-profile taxonomy', () => {
  const failures = []
  for (const dir of PRODUCTION_DIRS) {
    for (const file of files(path.join(ROOT, dir))) {
      const source = fs.readFileSync(file, 'utf8')
      for (const pattern of forbidden) {
        if (pattern.test(source)) failures.push(`${path.relative(ROOT, file)} :: ${pattern}`)
      }
    }
  }
  assert.deepEqual(failures, [])
})
