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

/**
 * Let a fetch ask for a revision by sha even though no ref points at it.
 *
 * MEASURED, because it is surprising: `acceptRevision` returns a commit and
 * writes NO REF. The revision becomes `refs/tlda/source/<project>` only when
 * `advanceHead` publishes it, which by design happens after the build. So
 * between acceptance and publication — precisely the window a build runs in —
 * the revision being built is reachable from nothing, and `upload-pack` refuses
 * to serve an object no advertised ref reaches. A client asking for it is told
 * "not our ref", which reads as a corrupt repository rather than as a rule.
 *
 * WHAT THIS ACTUALLY GRANTS, stated narrowly because the wide version is false.
 * It is direct access to an object by sha with no reachability requirement, so
 * it reaches things refs do not advertise: abandoned proposals, objects from
 * rolled-back source transactions, superseded revisions gc has not reaped. It is
 * NOT equivalent to `/api/projects/:name/source/:file?revision=…`, which is
 * daemon-mediated and file-scoped. It is acceptable because the repository holds
 * one project's own source and a read credential can already enumerate that.
 *
 * The alternative was a ref meaning "being built" — lifecycle state someone has
 * to write, move and clean up.
 *
 * PER REQUEST, NOT PER REPOSITORY, and that is the whole point of `-c`. Writing
 * `uploadpack.allowAnySHA1InWant` into a repository's config would make it a
 * permanent property of every project ever served over this route, including
 * every project that will never have a remote executor — a daemon doing an
 * ordinary push would flip it on the way past. This applies to one invocation of
 * one service and leaves nothing behind.
 */
const SHA_FETCH_FOR_THIS_REQUEST = ['-c', 'uploadpack.allowAnySHA1InWant=true']

function pktLine(text) {
  return `${(Buffer.byteLength(text) + 4).toString(16).padStart(4, '0')}${text}`
}

// Fetching and pushing are different authorities and this used to be one gate.
// `rw` was required for both, so the only credential that could FETCH a project
// was one that could also move its refs -- which is fine while the only client
// is a daemon that pushes, and wrong the moment something needs to read and
// must not write. A remote build executor is exactly that: it materializes a
// revision and renders it, and it must not be able to create a ref or advance a
// head. Read-only is now a credential the route can actually issue.
//
// ONE LIMIT, STATED RATHER THAN DISCOVERED: with token gating off,
// `validateToken` answers `rw` for everything (server/lib/auth.mjs), so on an
// ungated environment every credential is read-write whatever it was issued as.
// The separation below is real where gating is on and is not a claim about an
// ungated box.
function daemonCredentials(req, validateToken) {
  const header = req.headers.authorization || ''
  if (!header.startsWith('Basic ')) return null
  let decoded
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8') } catch { return null }
  const colon = decoded.indexOf(':')
  if (colon <= 0) return null
  const daemonId = decoded.slice(0, colon)
  const token = decoded.slice(colon + 1)
  if (!daemonId) return null
  const level = validateToken(token)
  if (level !== 'rw' && level !== 'read') return null
  return { daemonId, level }
}

// Which services a credential level may reach. `git-upload-pack` is the fetch
// half and is the only thing a `read` credential gets; everything that can move
// a ref stays behind `rw`.
const WRITING_SERVICES = new Set(['git-receive-pack'])

function runService({ service, gitDir, project, req = null, daemonId = null, advertise = false }) {
  return new Promise((resolve, reject) => {
    // `-c` is scoped to THIS spawn. See SHA_FETCH_FOR_THIS_REQUEST for why a
    // build's own revision cannot be fetched without it, and why it is not
    // written into the repository.
    const args = service === 'git-upload-pack' ? [...SHA_FETCH_FOR_THIS_REQUEST] : []
    args.push(service.replace(/^git-/, ''), '--stateless-rpc')
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
    // Checked for the ADVERTISEMENT as well as the service call, because
    // `info/refs?service=git-receive-pack` is where a client learns what it may
    // push onto. Refusing only the second half would let a read credential read
    // the write half's advertisement and fail later, which reads as a broken
    // route rather than as a refusal.
    if (WRITING_SERVICES.has(service) && credentials.level !== 'rw') {
      res.status(403).end(`${service} requires a read-write credential; this one is read-only`)
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
