import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import express, { Router } from 'express'

import { swapPreviewCopyIntoPlace } from '../lib/publish-copy.mjs'

/**
 * Take a copy of a build from the box that made it.
 *
 * The host is not the build server — Skip, 2026-09-21: *"i do not want my
 * fucking build server to be the host"* — so the copy has to cross between two
 * boxes. This is that crossing: it is copying files between two servers, and
 * the only reason it is not `scp` is that neither box runs an sshd and the
 * server holds no Fly credential. A POST over Fly's private network is the
 * route this app already uses to reach its peers.
 *
 * OPT-IN BY INTENT: mounted only where a deployment says it receives copies.
 *
 * `isPeer` is injectable for one reason: the unpack and the swap only ever run
 * on Fly, so off Fly the only caller is 127.0.0.1 and the network check refuses
 * before either of them is reached. Without the seam the half of this route
 * that writes to disk has no test that could fail for a defect in it, and its
 * first execution would be the deployed one. The default is unchanged.
 *
 * IT LISTENS WHERE THE PUBLIC CANNOT REACH IT, on its own socket bound to this
 * machine's Fly private address. That is the gate; the shared secret is the
 * second one behind it, and an absent secret REFUSES rather than defaulting
 * open, because the failure of the opposite is silent.
 *
 * NOT A ROUTE ON THE MAIN SERVER, and this was learned the hard way rather than
 * designed. Mounted there it inherited every way in that the server has: pic
 * publishes 443, 8443 and 10000 through Tailscale Funnel, so the route was on
 * the open internet with only the secret in front of it -- and the private-peer
 * check did not help, because the edge process that fronts those ports connects
 * to the server over 6PN itself, so every funnelled request arrives wearing a
 * peer's address. A check that passes for the traffic it exists to refuse is
 * worse than none: it reads as a second gate that is not there.
 *
 * The caller's address is still checked, for the case this socket is reachable
 * some other way, but the binding is what makes the claim true.
 */

// The served directory is spliced into no shell here, but it is renamed over,
// so it has to be a plain absolute path rather than whatever an env var holds.
const PLAIN_PATH = /^\/[A-Za-z0-9._\-/]*$/

// Every member has to be a plain relative path. tar's own defaults would refuse
// most of this, but "the tool would probably have caught it" is not a check.
const SAFE_MEMBER = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/

// A copy is a site, not a disk. Refused before it is written, because an ingest
// with no ceiling fills the volume the site is served from.
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

/** Fly's private network; a request from anywhere else is not a peer. */
export function isFlyPrivate(address) {
  return String(address || '').replace(/^::ffff:/, '').startsWith('fdaa:')
}

/** What this deployment says about receiving copies, or null if it does not. */
export function previewCopyReceiverConfig(env = process.env) {
  if (!env.TLDA_PREVIEW_COPY_RECEIVE) return null
  return {
    staticDir: env.TLDA_STATIC_DIR || '/app/server/persist/static-site',
    secret: env.TLDA_PREVIEW_COPY_SECRET || '',
    port: Number(env.TLDA_PREVIEW_COPY_PORT || 5181),
    // Fly puts this machine's 6PN address here. Binding it rather than every
    // interface is the whole security posture of this listener, so an absent
    // one is a refusal to start rather than a fallback: on this box the
    // fallback would be the funnelled interfaces.
    host: env.FLY_PRIVATE_IP || '',
  }
}

/**
 * Start the receiver on its own socket, or say why it did not.
 *
 * Returns the listening server, or null when this deployment does not receive
 * copies. Throws only for a configuration that cannot be honoured, because a
 * host that silently fails to listen is a preview that silently stops updating.
 */
export async function startPreviewCopyReceiver(config, { log = console } = {}) {
  if (!config) return null
  const { staticDir, secret, port, host } = config
  if (!host) {
    throw new Error(
      'this deployment says it receives preview copies, but FLY_PRIVATE_IP is unset, so there is no private ' +
      'address to bind and binding every interface would put the receiver on whatever this box publishes. ' +
      'Nothing is listening.',
    )
  }
  const app = express()
  app.use(createPreviewCopyReceiver({ staticDir, secret, log }))
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s))
    s.on('error', reject)
  })
  log.log(
    `[preview-copy] taking copies into ${staticDir}, listening on [${host}]:${port}` +
    `${secret ? '' : ' — NO SECRET SET, every copy will be refused'}`,
  )
  return server
}

export function createPreviewCopyReceiver({ staticDir, secret, log = console, maxBytes = MAX_ARCHIVE_BYTES, isPeer = isFlyPrivate }) {
  if (!PLAIN_PATH.test(staticDir)) {
    throw new Error(`a preview copy lands in a plain absolute path and ${JSON.stringify(staticDir)} is not one`)
  }
  const router = Router()

  router.post('/api/preview-copy', async (req, res) => {
    if (!secret) {
      log.warn('[preview-copy] refused: this box is configured to receive copies but has no secret to check')
      return res.status(503).json({ error: 'this box has no receiving secret configured' })
    }
    if (req.get('x-tlda-preview-copy') !== secret) {
      return res.status(401).json({ error: 'preview copy refused: wrong or missing secret' })
    }
    if (!isPeer(req.socket?.remoteAddress)) {
      log.warn(`[preview-copy] refused a correctly-signed copy from ${req.socket?.remoteAddress}: not a private-network peer`)
      return res.status(403).json({ error: 'preview copies are taken from private-network peers only' })
    }

    const work = await mkdtemp(join(tmpdir(), 'tlda-preview-copy-'))
    const archive = join(work, 'copy.tgz')
    const incoming = `${staticDir}.incoming`
    try {
      let received = 0
      req.on('data', chunk => {
        received += chunk.length
        if (received > maxBytes) req.destroy(new Error(`the copy exceeded ${maxBytes} bytes`))
      })
      await pipeline(req, createWriteStream(archive))

      const declared = req.get('x-tlda-preview-copy-sha256')
      const actual = createHash('sha256').update(await readFile(archive)).digest('hex')
      if (declared && declared !== actual) {
        return res.status(400).json({ error: `the copy arrived as ${actual.slice(0, 12)} and was sent as ${declared.slice(0, 12)}; nothing was written` })
      }

      const listed = await run('tar', ['tzf', archive])
      if (listed.code !== 0) {
        return res.status(400).json({ error: `the copy is not a readable archive: ${listed.stderr.trim() || `tar exited ${listed.code}`}` })
      }
      // `./` is the archive's own root -- `tar czf - -C <dir> .` always emits it
      // -- and it names nothing to write. Dropped rather than checked, because
      // stripping the `./` prefix leaves an empty string that no rule for a path
      // can sensibly pass. Found by the round-trip test below, which is the
      // whole reason that test exists: every real copy carries this member, so
      // the refusal would have been total and first seen on the deployed box.
      const members = listed.stdout.split('\n')
        .map(line => line.trim().replace(/^\.\//, ''))
        .filter(member => member && member !== '.')
      const unsafe = members.filter(member => !SAFE_MEMBER.test(member))
      if (unsafe.length) {
        return res.status(400).json({
          error: `the copy names ${unsafe.length} path(s) that would land outside ${staticDir}; nothing was written`,
          first: unsafe.slice(0, 5),
        })
      }

      await rm(incoming, { recursive: true, force: true })
      const unpack = await run('sh', ['-c', `mkdir -p "${incoming}" && tar xzf "${archive}" -C "${incoming}"`])
      if (unpack.code !== 0) {
        return res.status(500).json({ error: `the copy arrived but did not unpack: ${unpack.stderr.trim() || `tar exited ${unpack.code}`}` })
      }
      await swapPreviewCopyIntoPlace({ incoming, staticDir })
      log.log(`[preview-copy] ${members.length} member(s) now serving from ${staticDir}`)
      res.json({ ok: true, members: members.length, staticDir })
    } catch (error) {
      log.warn(`[preview-copy] the copy was not taken: ${error.message}`)
      if (!res.headersSent) res.status(500).json({ error: `the copy was not taken: ${error.message}` })
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  return router
}
