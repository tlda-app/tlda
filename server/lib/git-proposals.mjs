import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeRefComponent } from './source-git-store.mjs'

const ZERO = '0000000000000000000000000000000000000000'

function runGit(gitDir, args, { input = null, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--git-dir', gitDir, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', code => {
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8')
      if (code === 0) resolve({ stdout: out, stderr: err })
      else reject(Object.assign(new Error(err.trim() || `git ${args.join(' ')} exited ${code}`), { code, stdout: out, stderr: err }))
    })
    child.stdin.end(input == null ? undefined : input)
  })
}

export function proposalRef({ daemonId, branch, revision }) {
  if (!daemonId || !branch || !/^[0-9a-f]{40,64}$/.test(revision || '')) throw new Error('daemonId, branch, and revision are required')
  return `refs/tlda/proposals/${encodeRefComponent(daemonId)}/${branch}/${revision}`
}

export function parseProposalRef(ref, daemonId = null) {
  const root = 'refs/tlda/proposals/'
  if (!ref.startsWith(root)) return null
  let rest = ref.slice(root.length)
  let resolvedDaemon = daemonId
  if (daemonId) {
    const daemonPrefix = `${encodeRefComponent(daemonId)}/`
    if (!rest.startsWith(daemonPrefix)) return null
    rest = rest.slice(daemonPrefix.length)
  } else {
    const firstSlash = rest.indexOf('/')
    if (firstSlash <= 0) return null
    resolvedDaemon = decodeURIComponent(rest.slice(0, firstSlash))
    rest = rest.slice(firstSlash + 1)
  }
  const slash = rest.lastIndexOf('/')
  if (slash <= 0) return null
  const branch = rest.slice(0, slash)
  const revision = rest.slice(slash + 1)
  if (!branch || !/^[0-9a-f]{40,64}$/.test(revision)) return null
  return { daemonId: resolvedDaemon, branch, revision }
}

export async function validateProposalUpdates({ gitDir, project, daemonId, input }) {
  const headRef = `refs/tlda/source/${encodeRefComponent(project)}`
  const head = await runGit(gitDir, ['rev-parse', '--verify', '--quiet', headRef])
    .then(result => result.stdout.trim() || null, () => null)
  for (const line of String(input).trim().split('\n').filter(Boolean)) {
    const [oldRevision, newRevision, ref] = line.trim().split(/\s+/)
    const parsed = parseProposalRef(ref, daemonId)
    if (!parsed || parsed.revision !== newRevision || oldRevision !== ZERO) {
      throw new Error(`proposal ref must be a new immutable ref in the authenticated daemon namespace: ${ref}`)
    }
    if (head) {
      try {
        await runGit(gitDir, ['merge-base', '--is-ancestor', head, newRevision])
      } catch {
        const error = new Error(`WrongHead ${head}`)
        error.wrongHead = head
        throw error
      }
    }
  }
  return true
}

export async function listProposalRefs(gitDir) {
  const result = await runGit(gitDir, [
    'for-each-ref', '--format=%(refname) %(objectname)', 'refs/tlda/proposals/',
  ])
  return result.stdout.trim().split('\n').filter(Boolean).map(line => {
    const space = line.lastIndexOf(' ')
    const ref = line.slice(0, space)
    const revision = line.slice(space + 1)
    const parsed = parseProposalRef(ref)
    return parsed && parsed.revision === revision ? { ...parsed, ref } : null
  }).filter(Boolean)
}

export function installProposalHooks(gitDir, hookScript) {
  const hooks = join(gitDir, 'hooks')
  mkdirSync(hooks, { recursive: true })
  const pre = join(hooks, 'pre-receive')
  const post = join(hooks, 'post-receive')
  writeFileSync(pre, '#!/bin/sh\nexec "$TLDA_NODE" "$TLDA_GIT_PROPOSAL_HOOK" pre-receive\n')
  writeFileSync(post, '#!/bin/sh\nexec "$TLDA_NODE" "$TLDA_GIT_PROPOSAL_HOOK" post-receive\n')
  chmodSync(pre, 0o755)
  chmodSync(post, 0o755)
  return { hookScript }
}

export { runGit }
