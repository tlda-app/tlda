import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { checkoutRemoteUrl, classSiteRefusal, commitAndPushClassSite, configuredPublicationTarget, deletionsFromPublish, remoteIsConfiguredTarget, stagePublishedTree, writePublishedTree } from './publish-class-site.mjs'

const sha = (text) => createHash('sha256').update(Buffer.from(text)).digest('hex')

function served(pages) {
  return async (url) => {
    const parsed = new URL(url)
    assert.equal(parsed.searchParams.get('_tldaPublishRaw'), '1')
    const path = decodeURIComponent(parsed.pathname.split('/static/')[1])
    if (!(path in pages)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(pages[path]) }
  }
}

function classSite() {
  const root = mkdtempSync(join(tmpdir(), 'tlda-class-site-'))
  execFileSync('git', ['init', '--quiet', '--initial-branch', 'main', root])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'a@b'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'test'])
  mkdirSync(join(root, 'static', 'book'), { recursive: true })
  writeFileSync(join(root, 'static', 'book', 'withdrawn.html'), 'a page he pulled')
  writeFileSync(join(root, 'README.md'), 'not part of the published tree')
  execFileSync('git', ['-C', root, 'add', '--all'])
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--message', 'the site as it stands'])
  return root
}

test('every listed file is fetched and checked against the hash the server gave', async () => {
  const pages = { 'book/one.html': 'chapter one', 'decks/one-slides.html': 'deck one' }
  const { staging, files } = await stagePublishedTree({
    serverUrl: 'https://preview.example',
    project: 'course',
    files: Object.entries(pages).map(([path, body]) => ({ path, size: body.length, sha256: sha(body) })),
    fetchImpl: served(pages),
  })
  try {
    assert.equal(files, 2)
    assert.equal(readFileSync(join(staging, 'book', 'one.html'), 'utf8'), 'chapter one')
    assert.equal(readFileSync(join(staging, 'decks', 'one-slides.html'), 'utf8'), 'deck one')
  } finally { rmSync(staging, { recursive: true, force: true }) }
})

// The check has to be able to fail, and it has to fail BEFORE anything reaches
// the site: bytes that do not match the inventory are the one case where
// publishing would put something in front of a class that nobody looked at.
test('bytes that are not the listed file stop the publish and leave nothing staged', async () => {
  await assert.rejects(
    stagePublishedTree({
      serverUrl: 'https://preview.example',
      project: 'course',
      files: [{ path: 'book/one.html', size: 11, sha256: sha('chapter one') }],
      fetchImpl: served({ 'book/one.html': 'something else entirely' }),
    }),
    /served bytes are not the file the server listed/,
  )
})

test('a file the server lists and does not serve names the address that failed', async () => {
  await assert.rejects(
    stagePublishedTree({
      serverUrl: 'https://preview.example',
      project: 'course',
      files: [{ path: 'book/missing.html', size: 1, sha256: sha('x') }],
      fetchImpl: served({}),
    }),
    /the server lists this file and serves 404 for it at https:\/\/preview\.example\/docs\/course\/static\/book\/missing\.html/,
  )
})

// The failure a merge would hide: a page he withdrew keeps serving itself to
// the class from the old site until something removes it.
test('publishing removes a page the build no longer produces', async () => {
  const checkout = classSite()
  const pages = { 'book/one.html': 'chapter one' }
  const { staging } = await stagePublishedTree({
    serverUrl: 'https://preview.example',
    project: 'course',
    files: [{ path: 'book/one.html', size: 11, sha256: sha('chapter one') }],
    fetchImpl: served(pages),
  })
  try {
    await writePublishedTree({ staging, checkout, subdirectory: 'static', allowDeletions: true })
    assert.equal(existsSync(join(checkout, 'static', 'book', 'withdrawn.html')), false, 'the withdrawn page must be gone')
    assert.equal(existsSync(join(checkout, 'static', 'book', 'one.html')), true)
    assert.equal(existsSync(join(checkout, 'README.md')), true, 'the rest of the site is untouched')
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(checkout, { recursive: true, force: true })
  }
})

test('a publish commits, and publishing the same thing again changes nothing', async () => {
  const checkout = classSite()
  const bare = mkdtempSync(join(tmpdir(), 'tlda-class-site-remote-'))
  try {
    execFileSync('git', ['init', '--quiet', '--bare', bare])
    execFileSync('git', ['-C', checkout, 'remote', 'add', 'origin', bare])
    writeFileSync(join(checkout, 'static', 'book', 'one.html'), 'chapter one')

    const first = await commitAndPushClassSite({ checkout, subdirectory: 'static', project: 'course', revision: 'a'.repeat(40) })
    assert.equal(first.changed, true)
    assert.equal(first.pushed, true)
    assert.match(
      execFileSync('git', ['-C', bare, 'log', '-1', '--format=%s', 'refs/heads/main'], { encoding: 'utf8' }),
      /^Publish course@aaaaaaa to the class site/,
      'the remote must actually have the commit',
    )

    // Publishing again is how somebody checks the first one worked, so it is
    // reported as unchanged rather than refused.
    const second = await commitAndPushClassSite({ checkout, subdirectory: 'static', project: 'course', revision: 'a'.repeat(40) })
    assert.deepEqual(second, { changed: false, files: 0, commit: null, pushed: false })
  } finally {
    rmSync(checkout, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  }
})

test('a checkout that is not a git repository is refused before anything is written', async () => {
  const notARepo = mkdtempSync(join(tmpdir(), 'tlda-not-a-repo-'))
  try {
    await assert.rejects(
      writePublishedTree({ staging: notARepo, checkout: notARepo, subdirectory: 'static' }),
      /is not a git checkout/,
    )
    assert.equal(existsSync(join(notARepo, 'static')), false)
  } finally { rmSync(notARepo, { recursive: true, force: true }) }
})

// The guard exists because the command is short. The manual crossing it
// replaces was a build, a copy and a push, and each of those was a place to
// notice you were on the wrong repository; one command has none of them.
test('the repository his students read is refused by name, and the refusal says where to send it', () => {
  for (const remote of [
    'https://github.com/qtm285/qtm285.github.io.git',
    'git@github.com:qtm285/qtm285.github.io.git',
    'https://x-access-token:REDACTED@github.com/qtm285/qtm285.github.io.git',
  ]) {
    const refusal = classSiteRefusal(remote)
    assert.ok(refusal, `${remote} is the class site and must be refused`)
    assert.match(refusal, /students read/)
  }
})

test('a test site and an unknown remote are not refused', () => {
  assert.equal(classSiteRefusal('https://github.com/qtm285/pages-topology-test.git'), null)
  assert.equal(classSiteRefusal('git@github.com:someone/anything-else.git'), null)
  // A checkout with no remote at all is a local bare-clone rehearsal, which is
  // how the command gets exercised without touching anything of his.
  assert.equal(classSiteRefusal(null), null)
})

test('a checkout with no origin answers null rather than throwing', async () => {
  const noRemote = mkdtempSync(join(tmpdir(), 'tlda-no-remote-'))
  try {
    execFileSync('git', ['init', '--quiet', noRemote])
    assert.equal(await checkoutRemoteUrl(noRemote), null)
  } finally { rmSync(noRemote, { recursive: true, force: true }) }
})

// The site is assembled by several producers -- the book build, the decks
// build, the solutions render -- and this command carries what ONE of them is
// serving. On this course the difference is not hypothetical: it is the
// solutions pages Skip asked not to vanish "until the app works consistently
// for my students", and the bootstrap deck from the 62-deletion incident.
test('a publish that would take another producers pages off the site refuses and names them', async () => {
  const checkout = classSite()
  const staging = mkdtempSync(join(tmpdir(), 'tlda-staging-'))
  try {
    mkdirSync(join(checkout, 'static', 'book', 'homework'), { recursive: true })
    writeFileSync(join(checkout, 'static', 'book', 'homework', 'hw1-solutions.html'), 'from the solutions render')
    mkdirSync(join(staging, 'book'), { recursive: true })
    // The new tree still LINKS the solutions page, which is what makes its
    // removal a loss rather than a withdrawal.
    writeFileSync(join(staging, 'book', 'index.html'), '<a href="homework/hw1-solutions.html">solutions</a>')
    writeFileSync(join(staging, 'book', 'one.html'), 'chapter one')

    const { lost } = await deletionsFromPublish({ staging, checkout, subdirectory: 'static' })
    assert.ok(lost.includes('book/homework/hw1-solutions.html'), 'the solutions page is still linked and would go')

    await assert.rejects(
      writePublishedTree({ staging, checkout, subdirectory: 'static' }),
      /still point at[\s\S]*hw1-solutions\.html/,
    )
    assert.equal(
      readFileSync(join(checkout, 'static', 'book', 'homework', 'hw1-solutions.html'), 'utf8'),
      'from the solutions render',
      'a refused publish must not have written anything',
    )
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(checkout, { recursive: true, force: true })
  }
})

test('a publish that adds and replaces without removing needs no permission', async () => {
  const checkout = classSite()
  const staging = mkdtempSync(join(tmpdir(), 'tlda-staging-keep-'))
  try {
    mkdirSync(join(staging, 'book'), { recursive: true })
    writeFileSync(join(staging, 'book', 'withdrawn.html'), 'same page, new words')
    writeFileSync(join(staging, 'book', 'new.html'), 'a page this build added')

    assert.deepEqual(await deletionsFromPublish({ staging, checkout, subdirectory: 'static' }), { lost: [], droppable: [] })
    const result = await writePublishedTree({ staging, checkout, subdirectory: 'static' })
    assert.equal(result.removed, 0)
    assert.equal(readFileSync(join(checkout, 'static', 'book', 'withdrawn.html'), 'utf8'), 'same page, new words')
    assert.equal(existsSync(join(checkout, 'static', 'book', 'new.html')), true)
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(checkout, { recursive: true, force: true })
  }
})

// The destination is configured in the course -- `course-release.json`'s
// `publication.repository`, the same field `build-site.py` refuses on -- so the
// two producers refuse the same way rather than holding two opinions about
// where this course publishes.
test('the publication target comes from the course, and a checkout of another repository is not it', () => {
  const target = configuredPublicationTarget({
    publication: { repository: 'qtm285/pages-topology-test', url: 'https://qtm285.github.io/pages-topology-test/' },
  })
  assert.deepEqual(target, { repository: 'qtm285/pages-topology-test', url: 'https://qtm285.github.io/pages-topology-test/' })

  for (const remote of [
    'https://github.com/qtm285/pages-topology-test.git',
    'git@github.com:qtm285/pages-topology-test',
  ]) assert.equal(remoteIsConfiguredTarget(remote, target.repository), true, `${remote} is the configured target`)

  // The mistake the check exists for: a checkout of the site his students read,
  // named to a command whose course says it publishes somewhere else.
  assert.equal(remoteIsConfiguredTarget('https://github.com/qtm285/qtm285.github.io.git', target.repository), false)
})

test('a course naming no publication target configures nothing rather than guessing one', () => {
  assert.equal(configuredPublicationTarget(null), null)
  assert.equal(configuredPublicationTarget({}), null)
  assert.equal(configuredPublicationTarget({ publication: {} }), null)
  assert.equal(remoteIsConfiguredTarget('https://github.com/x/y.git', null), false)
})

// `deploy-currency`'s case, and the one a source mapping would have missed:
// four figures stored under one chapter's assets directory are referenced by a
// DIFFERENT chapter. Asking what produced the file says they are superseded;
// following the references says they are live images on a current page.
test('a file referenced from another chapters page is a loss, not a withdrawal', async () => {
  const checkout = classSite()
  const staging = mkdtempSync(join(tmpdir(), 'tlda-staging-xref-'))
  try {
    mkdirSync(join(checkout, 'static', 'book', 'chapters', 'without-replacement_files', 'figure-html'), { recursive: true })
    writeFileSync(join(checkout, 'static', 'book', 'chapters', 'without-replacement_files', 'figure-html', 'fig-binom-1.svg'), '<svg/>')
    mkdirSync(join(staging, 'book', 'chapters'), { recursive: true })
    writeFileSync(join(staging, 'book', 'withdrawn.html'), 'kept so the fixture only tests the figure')
    writeFileSync(
      join(staging, 'book', 'chapters', 'bootstrap.html'),
      '<img src="without-replacement_files/figure-html/fig-binom-1.svg?v=123">',
    )

    const { lost, droppable } = await deletionsFromPublish({ staging, checkout, subdirectory: 'static' })
    assert.deepEqual(lost, ['book/chapters/without-replacement_files/figure-html/fig-binom-1.svg'])
    assert.deepEqual(droppable, [])
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(checkout, { recursive: true, force: true })
  }
})

// Their catch rather than mine: a refused page's own assets are referenced only
// by it, so on a single pass they look unreachable and get dropped -- quietly
// discarding the figures of exactly the page just protected.
test('the assets of a refused page are refused with it, to fixpoint', async () => {
  const checkout = classSite()
  const staging = mkdtempSync(join(tmpdir(), 'tlda-staging-fixpoint-'))
  try {
    mkdirSync(join(checkout, 'static', 'book', 'decks', 'deck_files', 'figure-revealjs'), { recursive: true })
    writeFileSync(
      join(checkout, 'static', 'book', 'decks', 'deck-slides.html'),
      '<img src="deck_files/figure-revealjs/plot-1.svg">',
    )
    writeFileSync(join(checkout, 'static', 'book', 'decks', 'deck_files', 'figure-revealjs', 'plot-1.svg'), '<svg/>')
    mkdirSync(join(staging, 'book'), { recursive: true })
    writeFileSync(join(staging, 'book', 'withdrawn.html'), 'kept')
    writeFileSync(join(staging, 'book', 'index.html'), '<a href="decks/deck-slides.html">the deck</a>')

    const { lost, droppable } = await deletionsFromPublish({ staging, checkout, subdirectory: 'static' })
    assert.ok(lost.includes('book/decks/deck-slides.html'), 'the deck is linked from the new index, so it is a loss')
    assert.ok(
      lost.includes('book/decks/deck_files/figure-revealjs/plot-1.svg'),
      'and its figure must be kept with it -- nothing in the NEW tree points at the figure, only the refused deck does',
    )
    assert.deepEqual(droppable, [])
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(checkout, { recursive: true, force: true })
  }
})

// The other half, and the reason the override flag stops being the daily path:
// a page nothing points at any more is a withdrawal and goes without asking.
test('a page nothing links any more is withdrawn and needs no permission', async () => {
  const checkout = classSite()
  const staging = mkdtempSync(join(tmpdir(), 'tlda-staging-withdraw-'))
  try {
    mkdirSync(join(checkout, 'static', 'book'), { recursive: true })
    writeFileSync(join(checkout, 'static', 'book', 'retired.html'), 'a chapter he took out')
    mkdirSync(join(staging, 'book'), { recursive: true })
    writeFileSync(join(staging, 'book', 'withdrawn.html'), 'kept')
    writeFileSync(join(staging, 'book', 'index.html'), '<a href="withdrawn.html">what is left</a>')

    const { lost, droppable } = await deletionsFromPublish({ staging, checkout, subdirectory: 'static' })
    assert.deepEqual(lost, [], 'nothing points at it, so nothing is lost')
    assert.deepEqual(droppable, ['book/retired.html'])

    const result = await writePublishedTree({ staging, checkout, subdirectory: 'static' })
    assert.equal(result.withdrawn, 1)
    assert.equal(existsSync(join(checkout, 'static', 'book', 'retired.html')), false, 'a withdrawal must actually come off the site')
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(checkout, { recursive: true, force: true })
  }
})
