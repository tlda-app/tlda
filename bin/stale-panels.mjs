#!/usr/bin/env node

// Is what my browser shows the same as what is on my disk?
//
// Skip, 2026-08-23, after six document panels all showing text hours older than
// their files: "WE NEED A FUCKING MONITOR ... IT CAN BE LIKE A LITTLE SHELL
// THING", and the requirement in his words: "I'm on the Air, the doc is on the
// mini, make sure my browser updates with the files".
//
// So this compares, per project, each markdown DOCUMENT ROOT's bytes on this
// machine against the text the server serves for that document — the same URL
// the canvas panel loads. It changes nothing.
//
// **It deliberately does not monitor parts.** A part is a copy the server took
// when someone clicked a file in chat, and its `sourcePath` — the one fact that
// would say which file it came from — is written into the manifest and never
// exposed by any route. Watching them would mean adding a route to serve a
// mechanism Skip has ruled out: a markdown file you open is a root, rendered
// live, never copied. This watches the thing that is supposed to be true.
//
// Usage:  node bin/stale-panels.mjs [project ...]      one shot, exit 1 if behind
//         node bin/stale-panels.mjs --watch [project]  every 30s

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getRwToken, getServerUrl, getActiveEnvName } from '../shared/config.mjs'
import { tldaFetch } from '../shared/http-client.mjs'

const args = process.argv.slice(2)
const watch = args.includes('--watch')
const projects = args.filter(a => !a.startsWith('--'))

const isTTY = process.stderr.isTTY
const red = s => isTTY ? `\x1b[31m${s}\x1b[0m` : s
const green = s => isTTY ? `\x1b[32m${s}\x1b[0m` : s
const dim = s => isTTY ? `\x1b[2m${s}\x1b[0m` : s

const server = () => getServerUrl()

const api = (path) => tldaFetch(path, {
  method: 'GET',
  server: server(),
  environmentName: getActiveEnvName(),
  token: getRwToken(),
  timeoutMs: 30000,
})

async function fetchText(path) {
  const res = await fetch(`${server()}${path}`, {
    headers: getRwToken() ? { Authorization: `Bearer ${getRwToken()}` } : {},
  })
  if (!res.ok) return { error: `${res.status}` }
  return { text: await res.text() }
}

// The rendered page is HTML around the document; the file is markdown. Neither
// side is comparable as bytes, so both are reduced to their words. That is
// coarse on purpose — it answers "is my text there", which is the question,
// and it cannot be fooled by a template change on either side.
// Only runs of letters survive. Punctuation, markdown syntax, HTML entities and
// digits all render differently on the two sides -- `---` becomes an `<hr>` and
// vanishes, `&` becomes `&amp;`, a heading loses its hashes -- and a comparison
// that includes any of them reports a difference on every document forever. A
// monitor that always says BEHIND is one nobody reads, and then it catches
// nothing. This is deliberately coarse: it answers "are my words there".
function words(text) {
  return String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    // Entities before the letter split, or `&amp;` becomes the word "amp" and
    // every document with an ampersand in it reports BEHIND. That was this
    // script's first false positive and it took a tail-by-tail diff to see.
    .replace(/&[a-zA-Z]+;|&#\d+;/g, ' ')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(w => w.length > 1)
}

// The tail is where an edit lands while someone is writing, and the tail is what
// a frozen copy is missing. Comparing the last N words finds a panel that stopped
// following its file, without failing on every difference of rendering.
const TAIL = 25

async function checkProject(name, sourceDir) {
  const project = await api(`/api/projects/${encodeURIComponent(name)}`)
  const roots = (project?.documentRoots || []).filter(r => r?.format === 'markdown' && r.path)
  const rows = []
  for (const root of roots) {
    const local = join(sourceDir, root.path)
    if (!existsSync(local)) { rows.push({ path: root.path, state: 'no-local-file', local }); continue }
    const stem = root.path.replace(/\.(md|markdown)$/i, '')
    const served = await fetchText(`/docs/${encodeURIComponent(name)}/${stem}.html`)
    if (served.error) { rows.push({ path: root.path, state: `served-${served.error}`, local }); continue }

    const diskWords = words(readFileSync(local, 'utf8'))
    const pageWords = words(served.text)
    const diskText = diskWords.join(' ')
    const pageText = pageWords.join(' ')
    // BOTH directions, and the second one is the one that was missing. Asking
    // only "is the disk's ending in the page" passes for any file that is a
    // PREFIX of what the page holds — so a truncated file reported ok. Checking
    // that the page's ending is also on disk is what makes the two agree about
    // where the document stops. Caught by pointing this at a file cut to a third
    // of its length and watching it say ok.
    const diskEndsInPage = diskWords.length >= TAIL && pageText.includes(diskWords.slice(-TAIL).join(' '))
    const pageEndsOnDisk = pageWords.length >= TAIL && diskText.includes(pageWords.slice(-TAIL).join(' '))
    rows.push({
      path: root.path,
      local,
      state: diskEndsInPage && pageEndsOnDisk ? 'current' : 'behind',
      diskWords: diskWords.length,
      pageWords: pageWords.length,
    })
  }
  return rows
}

// The project's files are wherever its checkout is on THIS machine. The server
// cannot tell us that — the binding is the daemon's — so it is an argument, and
// the default is the directory you are standing in.
const sourceDir = process.env.TLDA_SOURCE_DIR || process.cwd()

async function run() {
  const names = projects.length
    ? projects
    : ((await api('/api/projects'))?.projects || []).map(p => p.name)

  let behind = 0
  let checked = 0
  for (const name of names) {
    let rows
    try {
      rows = await checkProject(name, sourceDir)
    } catch (e) {
      console.log(`${name}: could not read — ${e.message}`)
      continue
    }
    if (!rows.length) continue
    console.log(`\n${name}  ${dim(sourceDir)}`)
    for (const row of rows) {
      checked++
      if (row.state === 'current') {
        console.log(`  ${green('ok')}      ${row.path}  ${dim(`${row.diskWords} words`)}`)
      } else if (row.state === 'behind') {
        behind++
        console.log(`  ${red('BEHIND')}  ${row.path}`)
        console.log(`          disk ${row.diskWords} words · page ${row.pageWords} words`)
        console.log(`          ${row.local}`)
      } else {
        behind++
        console.log(`  ${red(row.state)}  ${row.path}`)
        console.log(`          ${row.local}`)
      }
    }
  }
  // Saying nothing was checked is not the same as saying everything is fine, and
  // a monitor that cannot tell those apart is the one that gets believed wrongly.
  if (!checked) console.log(dim('\nNo markdown document roots found. Nothing was checked.'))
  else if (!behind) console.log(green('\nEvery document root matches its file.'))
  return behind
}

if (watch) {
  for (;;) {
    console.log(dim(`\n— ${new Date().toLocaleTimeString()} —`))
    await run()
    await new Promise(r => setTimeout(r, 30000))
  }
} else {
  process.exit(await run() ? 1 : 0)
}
