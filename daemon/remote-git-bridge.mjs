import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

export function createRemoteGitBridge({ sourceDir, remote = 'origin', branch = 'main', onRemoteSettled, log = console } = {}) {
  if (!sourceDir || typeof onRemoteSettled !== 'function') throw new Error('sourceDir and onRemoteSettled are required')
  const observedRef = 'refs/tlda/remote/observed'
  const publishedRef = 'refs/tlda/remote/published'
  let operation = Promise.resolve()

  async function git(args) {
    return execFile('git', args, { cwd: sourceDir, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
  }
  async function rev(ref) { try { return (await git(['rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim() } catch { return null } }
  async function ancestor(a, b) { try { await git(['merge-base', '--is-ancestor', a, b]); return true } catch { return false } }
  async function conflictedFiles() {
    return (await git(['diff', '--name-only', '--diff-filter=U', '-z'])).stdout.split('\0').filter(Boolean)
  }

  async function pollOnce() {
    await git(['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`])
    const fetched = await rev(`refs/remotes/${remote}/${branch}`)
    const observed = await rev(observedRef)
    const held = await conflictedFiles()
    if (held.length) return { ok: false, status: 'conflicted', conflicted: held, revision: fetched }
    if (!fetched || fetched === observed) return { ok: true, status: 'unchanged', revision: fetched }
    await git(['update-ref', observedRef, fetched, observed || '0000000000000000000000000000000000000000'])
    const published = await rev(publishedRef)
    if (fetched === published) return { ok: true, status: 'publication-acknowledged', revision: fetched }
    try {
      await git(['merge', '--no-edit', fetched])
    } catch (error) {
      const conflicted = await conflictedFiles()
      if (!conflicted.length) throw error
      return { ok: false, status: 'conflicted', conflicted, revision: fetched }
    }
    await onRemoteSettled({ revision: await rev('HEAD'), remoteRevision: fetched })
    return { ok: true, status: 'merged', revision: fetched }
  }

  async function publishOnce(revision) {
    try {
      await git(['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`])
    } catch (error) {
      if (!/couldn't find remote ref|remote ref does not exist/i.test(error.stderr || error.message || '')) throw error
    }
    const remoteHead = await rev(`refs/remotes/${remote}/${branch}`)
    if (remoteHead && !(await ancestor(remoteHead, revision))) return pollOnce()
    try {
      await git(['push', remote, `${revision}:refs/heads/${branch}`])
    } catch (error) {
      log.warn?.(`remote push rejected; fetching and merging: ${error.message}`)
      return pollOnce()
    }
    const previous = await rev(publishedRef)
    await git(['update-ref', publishedRef, revision, previous || '0000000000000000000000000000000000000000'])
    return { ok: true, status: 'published', revision }
  }

  function serialized(run) {
    operation = operation.then(run, run)
    return operation
  }

  const poll = () => serialized(pollOnce)
  const publish = revision => serialized(() => publishOnce(revision))

  return { poll, publish, refs: { observedRef, publishedRef } }
}
