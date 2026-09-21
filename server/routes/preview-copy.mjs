import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { Router } from 'express'

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
 * TWO GATES, BOTH REQUIRED. A shared secret, and the caller being on Fly's
 * private network. The secret alone is not enough on a box that is also behind
 * a funnel, and an endpoint that unpacks an archive is not one to leave a
 * single mistake away from the open internet. An absent secret REFUSES rather
 * than defaulting open, because the failure of the opposite is silent.
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
  }
}

export function createPreviewCopyReceiver({ staticDir, secret, log = console, maxBytes = MAX_ARCHIVE_BYTES }) {
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
    if (!isFlyPrivate(req.socket?.remoteAddress)) {
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
      const members = listed.stdout.split('\n').map(line => line.trim()).filter(Boolean)
      const unsafe = members.filter(member => !SAFE_MEMBER.test(member.replace(/^\.\//, '')))
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
