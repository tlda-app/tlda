/**
 * Send what the app is serving to the class site.
 *
 * Skip's definition, 2026-09-19: *"'publishing' means preview — which matches
 * testing which, daemon not being broken, matches disk — gets sent to the class
 * site."* So this takes THE BUILT TREE THE SERVER IS ALREADY SERVING and puts
 * those bytes on the site. It does not render, it does not rebuild from a
 * committed revision, and it does not read a release contract. Each of those is
 * an indirection between what he looked at and what his class gets, and the gap
 * inside one of them is where stale solutions lived.
 *
 * The bytes come from the addresses that already serve them —
 * `/docs/<project>/static/<path>` — checked against the hashes the server
 * reports for its own files. Nothing here is a second way to obtain a published
 * page, because a second way is a second answer to what is published.
 */

import { execFile as execFileCb } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, cp, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFileCb)

/**
 * Stage the whole published tree, verified, before the class site is touched.
 *
 * Nothing is written to the site until every file has arrived and matched its
 * hash. A half-written site is worse than an old one — it is an old one with
 * holes in it, in front of a class — and a checkout is not a transaction.
 */
export async function stagePublishedTree({ serverUrl, project, files, fetchImpl = fetch, headers = {} }) {
  const staging = await mkdtemp(join(tmpdir(), `tlda-publish-${project}-`))
  try {
    for (const file of files) {
      const url = `${serverUrl.replace(/\/$/, '')}/docs/${encodeURIComponent(project)}/static/${file.path.split('/').map(encodeURIComponent).join('/')}`
      const response = await fetchImpl(url, { headers })
      if (!response.ok) throw new Error(`${file.path}: the server lists this file and serves ${response.status} for it at ${url}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== file.sha256) {
        throw new Error(`${file.path}: served bytes are not the file the server listed (${digest.slice(0, 12)} against ${file.sha256.slice(0, 12)})`)
      }
      const target = join(staging, ...file.path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }
    return { staging, files: files.length }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

/**
 * Replace the class site's published tree with the staged one.
 *
 * WHOLESALE, not a merge. A page he withdrew has to disappear from the site;
 * copying over the top leaves it there, serving itself to the class. That is
 * the same failure as a stale solution arriving by omission instead of by age,
 * and it is the one a publish step is most likely to get wrong quietly.
 */
export async function writePublishedTree({ staging, checkout, subdirectory }) {
  if (!existsSync(join(checkout, '.git'))) {
    throw new Error(`${checkout} is not a git checkout — publishing commits and pushes, so it needs one`)
  }
  const destination = resolve(checkout, subdirectory)
  await rm(destination, { recursive: true, force: true })
  await cp(staging, destination, { recursive: true })
  return { destination, entries: (await readdir(destination)).length }
}

/**
 * Commit and push the class site, reported in terms of the site rather than of
 * git.
 *
 * An unchanged site is reported as unchanged and is not an error: publishing
 * again is how somebody checks the first one worked. Everything else throws,
 * because a publish that did not publish must never read like one that did.
 */
export async function commitAndPushClassSite({ checkout, subdirectory, project, revision, remote = 'origin', branch = 'main', push = true }) {
  const git = async (...args) => (await execFileAsync('git', args, { cwd: checkout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout
  await git('add', '--all', '--', subdirectory)
  const staged = (await git('diff', '--cached', '--name-only', '--', subdirectory)).split('\n').filter(Boolean)
  if (staged.length === 0) return { changed: false, files: 0, commit: null, pushed: false }
  const stamp = revision ? `@${revision.slice(0, 7)}` : ''
  await git('commit', '--quiet', '--message', `Publish ${project}${stamp} to the class site`)
  const commit = (await git('rev-parse', 'HEAD')).trim()
  if (!push) return { changed: true, files: staged.length, commit, pushed: false }
  await git('push', remote, `HEAD:${branch}`)
  return { changed: true, files: staged.length, commit, pushed: true }
}
