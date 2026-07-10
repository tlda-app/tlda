import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'

const execFileP = promisify(execFile)

async function gitRetryOnLock(fn, retries = 3, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i < retries - 1 && /index\.lock|Unable to create.*lock|cannot lock ref|unable to update local ref/i.test(e.message || '')) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
        continue
      }
      throw e
    }
  }
}

export function createShadowMirror({ getSourceDir, log }) {
  async function mirrorShadowRef({ project, hash, bundleBase64 }) {
    if (!project) throw new Error('missing project')
    if (!/^[0-9a-f]{40}$/i.test(String(hash || ''))) throw new Error(`invalid shadow hash: ${hash}`)
    if (!bundleBase64) throw new Error('missing shadow bundle')

    const sourceDir = getSourceDir(project)
    if (!sourceDir) throw new Error(`project ${project} is not watched on this daemon`)

    try {
      await execFileP('git', ['rev-parse', '--git-dir'], { cwd: sourceDir, timeout: 5000 })
    } catch {
      throw new Error(`sourceDir is not a git repo: ${sourceDir}`)
    }

    const hash7 = hash.slice(0, 7)
    const bundlePath = path.join(os.tmpdir(), `tlda-shadow-${project}-${hash7}-${Date.now()}.bundle`)
    try {
      fs.writeFileSync(bundlePath, Buffer.from(bundleBase64, 'base64'))
      await execFileP('git', ['bundle', 'verify', bundlePath], { cwd: sourceDir, timeout: 10000 })
      await gitRetryOnLock(() => execFileP('git', ['fetch', bundlePath, `+${hash}:refs/tags/shadow/${hash7}`], { cwd: sourceDir, timeout: 30000 }))
      await execFileP('git', ['cat-file', '-e', `${hash}^{commit}`], { cwd: sourceDir, timeout: 5000 })
      await gitRetryOnLock(() => execFileP('git', ['update-ref', 'refs/tlda/shadow/HEAD', hash], { cwd: sourceDir, timeout: 5000 }))
      log.info(`mirrored ${project}@${hash7} into ${sourceDir}`)
      return { ok: true, project, hash, sourceDir, tag: `shadow/${hash7}` }
    } finally {
      try {
        fs.rmSync(bundlePath, { force: true })
      } catch (e) {
        // Temporary bundle cleanup must not mask the mirror result.
        log.warn(`failed to remove temporary shadow bundle ${bundlePath}: ${e.message}`)
      }
    }
  }

  return { mirrorShadowRef }
}
