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

import { execFile as execFileCb, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, cp, readFile, writeFile, readdir } from 'node:fs/promises'
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
export async function stagePublishedTree({ serverUrl, project, files, fetchImpl = fetch, headers = {}, half = 'static', layout = path => path }) {
  const staging = await mkdtemp(join(tmpdir(), `tlda-publish-${project}-`))
  // Which half of the publication the inventory's paths are relative to. A
  // single-half inventory lists `book/index.html` and the half is the prefix; a
  // both-halves inventory lists `static/book/index.html` and carries its own, so
  // adding one here would ask for `static/static/…`.
  const prefix = half ? `${encodeURIComponent(half)}/` : ''
  try {
    for (const file of files) {
      const url = `${serverUrl.replace(/\/$/, '')}/docs/${encodeURIComponent(project)}/${prefix}${file.path.split('/').map(encodeURIComponent).join('/')}`
      const response = await fetchImpl(url, { headers })
      if (!response.ok) throw new Error(`${file.path}: the server lists this file and serves ${response.status} for it at ${url}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== file.sha256) {
        throw new Error(`${file.path}: served bytes are not the file the server listed (${digest.slice(0, 12)} against ${file.sha256.slice(0, 12)})`)
      }
      const target = join(staging, ...layout(file.path).split('/'))
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
 * The repository a publish is allowed to reach, and the one it is not.
 *
 * Skip's standing instruction is that publication goes to the test site until
 * he has looked that site over himself. So this refuses the repository his
 * students read, by name, and says where to send it instead.
 *
 * The guard exists BECAUSE the command is short. The manual crossing this
 * replaces took a build, a copy and a push, and every one of those was a place
 * to notice you were on the wrong repository. One command has none, so the
 * noticing has to be here.
 */
const CLASS_SITE_REPOSITORIES = [/qtm285\.github\.io/i]

/**
 * The repository the course says it publishes to.
 *
 * Configured, not passed in. Skip: he thought the publication remote was
 * configured somewhere, and it is — `course-release.json` carries
 * `publication.repository`, and `build-site.py` already refuses to assemble
 * into a repository the course does not name. Reading the SAME field means the
 * two producers refuse the same way instead of holding two opinions about where
 * this course publishes.
 *
 * His "plan is junk on the fs" ruling was about the plan — the stage-then-
 * deploy contract, the release ids, the per-artifact CHANGE rows. `publication`
 * is not that. It is two strings naming a destination, and a second place to
 * record the destination is how a status display and a publish command come to
 * disagree about what "published" means.
 */
export function configuredPublicationTarget(courseRelease) {
  const repository = courseRelease?.publication?.repository
  if (typeof repository !== 'string' || !repository) return null
  return { repository, url: courseRelease.publication.url || null }
}

/** Whether a checkout's remote is the repository the course names. */
export function remoteIsConfiguredTarget(remoteUrl, repository) {
  if (!remoteUrl || !repository) return false
  const owner = repository.replace(/\.git$/, '').toLowerCase()
  return remoteUrl.replace(/\.git$/, '').toLowerCase().endsWith(owner)
}

export function classSiteRefusal(remoteUrl) {
  if (!remoteUrl) return null
  return CLASS_SITE_REPOSITORIES.some(pattern => pattern.test(remoteUrl))
    ? `${remoteUrl} is the site his students read. Publication goes to the test site until he has looked that one over himself.`
    : null
}

export async function checkoutRemoteUrl(checkout, remote = 'origin') {
  try {
    const { stdout } = await execFileAsync('git', ['-C', checkout, 'remote', 'get-url', remote], { encoding: 'utf8' })
    return stdout.trim()
  } catch {
    return null
  }
}

async function filesUnder(root, prefix = '') {
  const found = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...await filesUnder(join(root, entry.name), path))
    else if (entry.isFile()) found.push(path)
  }
  return found
}

const REFERENCE = /(?:href|src)\s*=\s*(['"])([^'"]+)\1/gi

/** Every local path an HTML file points at, resolved against its own location. */
function referencesFrom(html, fromPath) {
  const base = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
  const found = new Set()
  for (const [, , raw] of html.matchAll(REFERENCE)) {
    const target = raw.split(/[?#]/, 1)[0]
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('/')) continue
    let decoded
    try { decoded = decodeURIComponent(target) } catch { continue }
    const parts = base ? base.split('/') : []
    for (const segment of decoded.split('/')) {
      if (segment === '.' || segment === '') continue
      if (segment === '..') parts.pop()
      else parts.push(segment)
    }
    found.add(parts.join('/'))
  }
  return found
}

async function readIfHtml(root, path) {
  if (!/\.html?$/i.test(path)) return null
  try { return await readFile(join(root, ...path.split('/')), 'utf8') } catch { return null }
}

/**
 * Split what this publish would remove into what is safe to drop and what
 * would be a loss.
 *
 * THE RULE IS REACHABILITY, not declaration: is the file still pointed at by
 * something. `deploy-currency` found this by trying to build the fixture for
 * the declaration rule I was going to write, and it is better — it sidesteps
 * `output-file:` renames, solutions pages sharing a master, and decks living
 * outside the chapter tree, because it never asks what produced a file, only
 * whether anything still points at it. A withdrawal is then exactly "nothing
 * references it", which is mechanically true of a page Skip withdrew and
 * mechanically false of a page a producer failed to make.
 *
 * Their instance is the one a source mapping would have missed: four figures
 * under `chapter-sampling-without-replacement_files/` are referenced by
 * `chapter-bootstrap.html`, a different chapter. The declaration is fine either
 * way; only following the actual references sees it.
 *
 * IT RUNS TO FIXPOINT, and that is their catch rather than mine. A refused
 * page's own assets are referenced only by it, so on one pass they look
 * unreachable and get dropped — which would quietly discard the figures of
 * exactly the page just protected. So anything refused is then read for what
 * IT points at, and those are refused too, until nothing new is added.
 */
export async function deletionsFromPublish({ staging, checkout, subdirectory }) {
  const destination = resolve(checkout, subdirectory)
  const incoming = new Set(await filesUnder(staging))
  const removed = (await filesUnder(destination)).filter(path => !incoming.has(path))
  if (removed.length === 0) return { lost: [], droppable: [] }

  const candidates = new Set(removed)
  const lost = new Set()
  // Seed: anything the NEW tree still points at is live, whatever this build
  // failed to produce.
  let frontier = []
  for (const path of incoming) {
    const html = await readIfHtml(staging, path)
    if (html) frontier.push(...referencesFrom(html, path))
  }
  while (frontier.length > 0) {
    const next = []
    for (const target of frontier) {
      if (!candidates.has(target) || lost.has(target)) continue
      lost.add(target)
      // Fixpoint: what this kept file points at is kept with it.
      const html = await readIfHtml(destination, target)
      if (html) next.push(...referencesFrom(html, target))
    }
    frontier = next
  }
  return {
    lost: [...lost].sort(),
    droppable: removed.filter(path => !lost.has(path)).sort(),
  }
}

/**
 * Replace the class site's published tree with the staged one.
 *
 * WHOLESALE, not a merge. A page he withdrew has to disappear from the site;
 * copying over the top leaves it there, serving itself to the class — the same
 * failure as a stale solution, arriving by omission instead of by age.
 *
 * But the site is assembled by SEVERAL producers — the book build, the decks
 * build, the solutions render — and this command carries what ONE of them is
 * serving, so a wholesale replacement can wholesale-delete what the others put
 * there. On this course that set is not hypothetical: it is the solutions pages
 * Skip asked not to vanish "until the app works consistently for my students",
 * and the bootstrap deck from the 62-deletion incident. So wholesale is kept
 * and the removals are SPLIT: see `deletionsFromPublish`.
 */
export async function writePublishedTree({ staging, checkout, subdirectory, allowDeletions = false }) {
  if (!existsSync(join(checkout, '.git'))) {
    throw new Error(`${checkout} is not a git checkout — publishing commits and pushes, so it needs one`)
  }
  // Only a LOSS stops the publish. A file nothing points at any more is a
  // withdrawal and goes quietly, which is what keeps the override flag from
  // becoming the daily path and therefore meaningless — `deploy-currency` hit
  // exactly that deadlock, where their guard could refuse to publish but could
  // never take anything down.
  const { lost, droppable } = await deletionsFromPublish({ staging, checkout, subdirectory })
  if (lost.length > 0 && !allowDeletions) {
    const shown = lost.slice(0, 10).map(path => `  ${path}`).join('\n')
    throw new Error(
      `publishing would remove ${lost.length} file(s) that pages on the site still point at:\n${shown}` +
      `${lost.length > 10 ? `\n  …and ${lost.length - 10} more` : ''}\n` +
      `Something still links these, so they are missing from this build rather than withdrawn.`,
    )
  }
  const destination = resolve(checkout, subdirectory)
  await rm(destination, { recursive: true, force: true })
  await cp(staging, destination, { recursive: true })
  return { destination, entries: (await readdir(destination)).length, removed: lost.length + droppable.length, withdrawn: droppable.length }
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

/**
 * Put the staged tree on the preview box.
 *
 * The preview destination is not a git checkout, so none of the class-site
 * machinery above applies to it: nothing is committed, nothing is pushed to a
 * remote, and there is no second producer whose files a wholesale replacement
 * could delete. It is a directory on a Fly volume that one dumb file server
 * serves, and replacing it wholesale is the whole operation.
 *
 * TAR OVER `fly ssh console`, BECAUSE THE BOX HAS NO `rsync`. Measured on
 * tlda-pic-static 2026-09-21: `which rsync` finds nothing, `tar` and `node` are
 * present, and `fly ssh console -C` forwards stdin — a 261MB tree crossed in 32
 * seconds. Installing rsync would change the image every deployment shares, for
 * a transport that is already fast enough.
 *
 * THE SWAP IS SEPARATE FROM THE TRANSFER, so a connection that dies halfway
 * leaves the old site serving rather than half of the new one. The unpack lands
 * beside the served directory and only a rename puts it in front of anyone —
 * the same reason the server's own publication swaps rather than copying over
 * the top.
 */

/**
 * `fly ssh console -C` takes the remote command as ONE argument and splits it
 * itself, so a script reaching it has to survive that split. These scripts are
 * therefore written without a single quote in them and wrapped in single
 * quotes, and the directory is refused unless it is a plain path — the
 * alternative is nesting three levels of quoting through two parsers, which is
 * a thing that works until the day a path has a space in it.
 */
const PLAIN_PATH = /^\/[A-Za-z0-9._\-/]*$/

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function runShell(spawnImpl, command) {
  return new Promise((resolve, reject) => {
    // bash rather than sh for `pipefail`: without it the pipeline reports tar's
    // consumer and a producer that died mid-tree reads as a clean transfer.
    const child = spawnImpl('bash', ['-o', 'pipefail', '-c', command], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

function flyRemote(app, machine, script) {
  const target = `-a ${shellQuote(app)}${machine ? ` --machine ${shellQuote(machine)}` : ''}`
  return `fly ssh console ${target} -C ${shellQuote(`sh -lc '${script}'`)}`
}

export async function pushTreeToPreviewBox({ staging, app, machine, directory, spawnImpl = spawn }) {
  if (!PLAIN_PATH.test(directory)) {
    throw new Error(
      `the preview directory has to be a plain absolute path and ${JSON.stringify(directory)} is not. ` +
      'It is spliced into a shell command on the box, and this refuses rather than quoting it three times over.',
    )
  }
  const incoming = `${directory}.incoming`

  // THE PIPE IS A SHELL PIPE ON PURPOSE. Piping tar's stdout into `fly` from
  // node stalls: measured 2026-09-21, a 261MB tree reached 211MB and stopped,
  // twice, where the identical shell pipeline moved the same tree in 32
  // seconds. Whatever `fly ssh console` wants from its stdin, a real pipe
  // gives it and a node socket does not.
  const transfer = await runShell(spawnImpl,
    `tar czf - -C ${shellQuote(staging)} . | ` +
    flyRemote(app, machine, `rm -rf ${incoming} && mkdir -p ${incoming} && tar xzf - -C ${incoming}`),
  )
  if (transfer.code !== 0) {
    throw new Error(
      `the staged tree did not reach ${app}:${incoming} — the transfer exited ${transfer.code}. ` +
      `It said: ${transfer.stderr.trim() || transfer.stdout.trim() || '(nothing)'}. ` +
      `Nothing was swapped, so ${directory} is still serving what it was.`,
    )
  }

  // One rename in, one rename out, then the retired copy is dropped. The file
  // server resolves every request from the path and holds no directory handle,
  // so nothing is reading out of the tree being replaced.
  const swap = await runShell(spawnImpl, flyRemote(app, machine,
    `set -e; rm -rf ${directory}.previous; ` +
    `if [ -d ${directory} ]; then mv ${directory} ${directory}.previous; fi; ` +
    `mv ${incoming} ${directory}; ` +
    `rm -rf ${directory}.previous; ` +
    `echo SERVED; ls -A ${directory} | wc -l; du -sk ${directory} | cut -f1`,
  ))
  if (swap.code !== 0) {
    throw new Error(
      `the tree reached ${app} but was not put in front of the file server — fly exited ${swap.code}. ` +
      `It said: ${swap.stderr.trim() || swap.stdout.trim() || '(nothing)'}. ` +
      `${incoming} holds the transferred copy; ${directory} is whatever was there before.`,
    )
  }
  const lines = swap.stdout.split('\n').map(line => line.trim()).filter(Boolean)
  const marker = lines.indexOf('SERVED')
  const entries = Number(lines[marker + 1])
  const kilobytes = Number(lines[marker + 2])
  if (marker < 0 || !Number.isFinite(entries) || !Number.isFinite(kilobytes)) {
    throw new Error(
      `the swap on ${app} completed but said nothing countable about ${directory}, so this cannot report what is ` +
      `being served. It printed: ${JSON.stringify(swap.stdout.trim().slice(0, 400))}`,
    )
  }
  return { app, directory, entries, kilobytes }
}

/**
 * Which machine of the preview app to push to, resolved rather than assumed.
 *
 * `fly ssh console` without `--machine` picks one for you, and on an app that
 * has an edge process it picks the edge — a machine with no volume and no file
 * server, where the tree would land somewhere nothing serves and the publish
 * would still report success. So this asks, and refuses to guess when the
 * answer is not one machine.
 */
export async function resolvePreviewMachine(app, execFileImpl = execFileAsync) {
  const { stdout } = await execFileImpl('fly', ['machines', 'list', '-a', app, '--json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const machines = JSON.parse(stdout)
  const started = machines.filter(machine => machine.state === 'started')
  if (started.length === 1) return started[0].id
  if (started.length === 0) {
    throw new Error(
      `${app} has no started machine to publish to. ` +
      `It has ${machines.length}: ${machines.map(m => `${m.id} (${m.state})`).join(', ') || 'none at all'}.`,
    )
  }
  throw new Error(
    `${app} has ${started.length} started machines — ${started.map(m => `${m.id} (${m.region})`).join(', ')} — ` +
    'so which one serves the preview is not something this can pick. Name it with --to-preview-machine.',
  )
}
