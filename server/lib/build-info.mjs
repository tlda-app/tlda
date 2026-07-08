import { readFileSync } from 'node:fs'

const REQUIRED_STRING_FIELDS = ['gitSha', 'sha', 'ref', 'branch', 'builtAt']

export function readBuildInfo(stampPath) {
  let raw
  try {
    raw = readFileSync(stampPath, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ok: false, status: 503, error: 'build info stamp missing', path: stampPath }
    }
    return { ok: false, status: 500, error: `failed to read build info stamp: ${err.message}`, path: stampPath }
  }

  let info
  try {
    info = JSON.parse(raw)
  } catch (err) {
    return { ok: false, status: 500, error: `invalid build info JSON: ${err.message}`, path: stampPath }
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof info[field] !== 'string' || info[field].length === 0) {
      return { ok: false, status: 500, error: `invalid build info stamp: missing ${field}`, path: stampPath }
    }
  }

  return {
    ok: true,
    status: 200,
    buildInfo: {
      gitSha: info.gitSha,
      sha: info.sha,
      ref: info.ref,
      branch: info.branch,
      dirty: Boolean(info.dirty),
      checkoutPath: info.checkoutPath || null,
      builtAt: info.builtAt,
    },
  }
}
