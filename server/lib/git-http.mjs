import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createGunzip, createInflate } from 'node:zlib'
import { installProposalHooks, listProposalRefs } from './git-proposals.mjs'

// git compresses the upload-pack request body and says so, but not the
// receive-pack one. Piping the raw stream therefore fed gzip bytes to
// `upload-pack`, which exits non-zero, and every fetch answered 500 while every
// push worked — which is why this went unseen: the daemon only ever pushes.
export function decodedRequestStream(req) {
  const encoding = String(req?.headers?.['content-encoding'] || '').trim().toLowerCase()
  if (encoding === 'gzip' || encoding === 'x-gzip') return req.pipe(createGunzip())
  if (encoding === 'deflate') return req.pipe(createInflate())
  return req
}

const hookScript = fileURLToPath(new URL('../../bin/git-proposal-hook.mjs', import.meta.url))

function pktLine(text) {
  return `${(Buffer.byteLength(text) + 4).toString(16).padStart(4, '0')}${text}`
}

function daemonCredentials(req, validateToken) {
  const header = req.headers.authorization || ''
  if (!header.startsWith('Basic ')) return null
  let decoded
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8') } catch { return null }
  const colon = decoded.indexOf(':')
  if (colon <= 0) return null
  const daemonId = decoded.slice(0, colon)
  const token = decoded.slice(colon + 1)
  if (!daemonId || validateToken(token) !== 'rw') return null
  return { daemonId }
}

function runService({ service, gitDir, project, req = null, daemonId = null, advertise = false }) {
  return new Promise((resolve, reject) => {
    const args = [service.replace(/^git-/, ''), '--stateless-rpc']
    if (advertise) args.push('--advertise-refs')
    args.push(gitDir)
    const child = spawn('git', args, {
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        TLDA_GIT_DAEMON_ID: daemonId || '',
        TLDA_GIT_PROJECT: project || '',
        TLDA_GIT_PROPOSAL_HOOK: hookScript,
        TLDA_NODE: process.execPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let settled = false
    const settle = value => { if (!settled) { settled = true; resolve(value) } }
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', error => { if (!settled) { settled = true; reject(error) } })
    child.on('close', code => settle({
      code,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
    if (req) {
      // A body that is not the encoding it claims makes the decoder emit
      // `error`, and an unhandled `error` on a stream ends the process. The
      // request is untrusted, so that would be a way to stop the server by
      // sending eight bad bytes. Failures here take the same route a failed
      // service takes: a non-zero code the caller answers with 500.
      const input = decodedRequestStream(req)
      const fail = error => {
        child.kill()
        settle({ code: 1, stdout: Buffer.alloc(0), stderr: `request body: ${error.message}` })
      }
      input.on('error', fail)
      if (input !== req) req.on('error', fail)
      child.stdin.on('error', fail)
      input.pipe(child.stdin)
    } else child.stdin.end()
  })
}

export function createGitHttpHandler({ validateToken, repositoryForProject, admitProposal }) {
  return async function gitHttp(req, res, next) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const match = url.pathname.match(/^\/git\/([^/]+)\/(info\/refs|git-receive-pack|git-upload-pack)$/)
    if (!match) return next()
    const credentials = daemonCredentials(req, validateToken)
    if (!credentials) {
      res.setHeader('WWW-Authenticate', 'Basic realm="tlda git"')
      res.status(401).end('daemon credentials required')
      return
    }
    const project = decodeURIComponent(match[1])
    let repository
    try {
      repository = await repositoryForProject(project)
    } catch (error) {
      res.status(404).end(error.message)
      return
    }
    const gitDir = repository.gitDir
    installProposalHooks(gitDir, hookScript)
    const endpoint = match[2]
    const requestedService = url.searchParams.get('service')
    const service = endpoint === 'info/refs' ? requestedService : endpoint
    if (!['git-receive-pack', 'git-upload-pack'].includes(service)) {
      res.status(400).end('unsupported git service')
      return
    }
    if (endpoint === 'info/refs') {
      const result = await runService({ service, gitDir, project, daemonId: credentials.daemonId, advertise: true })
      if (result.code !== 0) {
        res.status(500).end(result.stderr)
        return
      }
      res.setHeader('Content-Type', `application/x-${service}-advertisement`)
      res.end(Buffer.concat([Buffer.from(pktLine(`# service=${service}\n`) + '0000'), result.stdout]))
      return
    }
    const result = await runService({ service, gitDir, project, req, daemonId: credentials.daemonId })
    if (service === 'git-receive-pack' && result.code === 0) {
      try {
        for (const proposal of await listProposalRefs(gitDir)) {
          await admitProposal({ project, ...proposal })
        }
      } catch (error) {
        // The ref is the durable input. A failed response deliberately leaves
        // it named for startup recovery rather than pretending admission was
        // complete; recovery ensures the same keyed record.
        res.status(500).end(error.message)
        return
      }
    }
    res.status(result.code === 0 ? 200 : 500)
    res.setHeader('Content-Type', `application/x-${service}-result`)
    res.end(result.stdout.length ? result.stdout : result.stderr)
  }
}
