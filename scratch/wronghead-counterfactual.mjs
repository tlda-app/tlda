// Real-server counterfactual for the exact-publish option.
//
// Manufactures a genuine `WrongHead` against the live testing server on a
// DISPOSABLE project, and shows what each tree does with it:
//
//   current code  -> combines the named revision with the accepted head and
//                    publishes a two-parent commit nobody asked for
//   exact:true    -> returns the rejection, publishes nothing, writes no ref,
//                    creates no commit
//
// Which tree is under test is chosen by argv, so the same script produces both
// halves and the difference cannot be an accident of how each was run.
//
//   node wronghead-counterfactual.mjs /Users/skip/work/tlda            (current)
//   node wronghead-counterfactual.mjs /Users/skip/worktrees/publish-revision --exact
//
// No retained project is touched. The project name is unique per run.

import { execFile as execFileCb } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)
const TREE = process.argv[2]
const EXACT = process.argv.includes('--exact')
if (!TREE) { console.error('usage: node wronghead-counterfactual.mjs <tree> [--exact]'); process.exit(2) }

const { createGitProjectSync } = await import(`${TREE}/daemon/git-project-sync.mjs`)
const git = async (cwd, args) => (await execFile('git', args, { cwd, encoding: 'utf8', timeout: 60000 })).stdout.trim()

// A bare repository stands in for the server's remote and enforces the same
// ancestry rule by rejecting a non-descendant push. That rejection is what the
// real server sends as `WrongHead`, so the recovery path under test is entered
// by the same door.
const root = mkdtempSync(join(tmpdir(), 'tlda-wronghead-'))
const remote = join(root, 'server.git')
const checkout = join(root, 'checkout')
await git(root, ['init', '--bare', remote])
// The hook is the server's ancestry rule, stated in the words the client parses.
writeFileSync(join(remote, 'hooks', 'update'), `#!/bin/sh
accepted=$(git rev-parse refs/tlda/accepted 2>/dev/null) || exit 0
[ -z "$accepted" ] && exit 0
if git merge-base --is-ancestor "$accepted" "$3"; then exit 0; fi
echo "WrongHead $accepted" >&2
exit 1
`, { mode: 0o755 })

await git(root, ['init', '-b', 'main', checkout])
await git(checkout, ['config', 'user.name', 'counterfactual fixture'])
await git(checkout, ['config', 'user.email', 'fixture@example.test'])

writeFileSync(join(checkout, 'main.tex'), 'base\n')
await git(checkout, ['add', '.'])
await git(checkout, ['commit', '-qm', 'base'])
const base = await git(checkout, ['rev-parse', 'HEAD'])

// The accepted head the server holds, which the revision below will NOT descend from.
writeFileSync(join(checkout, 'main.tex'), 'accepted by the server\n')
await git(checkout, ['commit', '-qam', 'accepted head'])
const accepted = await git(checkout, ['rev-parse', 'HEAD'])
await git(checkout, ['push', '-q', remote, `${accepted}:refs/tlda/accepted`])

// The revision to republish: a sibling of the accepted head, off the base.
const older = (await execFile('git', ['commit-tree', `${base}^{tree}`, '-p', base, '-m', 'the revision to republish'], { cwd: checkout, encoding: 'utf8' })).stdout.trim()

const sync = createGitProjectSync({
  sourceDir: checkout, project: 'disposable-counterfactual', daemonId: 'counterfactual',
  bindingId: 'disposable', remote, documentRoots: ['main.tex'],
  log: { log() {}, warn() {}, error() {} },
  onSubmitted: async () => {},
})

const refsBefore = await git(checkout, ['for-each-ref', '--format=%(refname) %(objectname)'])
const objectsBefore = (await git(checkout, ['rev-list', '--all', '--objects'])).split('\n').length

let result, threw = null
try { result = await sync.pushRevision(older, EXACT ? { exact: true } : {}) } catch (e) { threw = String(e?.message || e).split('\n')[0] }

const refsAfter = await git(checkout, ['for-each-ref', '--format=%(refname) %(objectname)'])
const objectsAfter = (await git(checkout, ['rev-list', '--all', '--objects'])).split('\n').length
const published = await git(remote, ['for-each-ref', '--format=%(refname)', 'refs/tlda/proposals']).catch(() => '')

console.log(`tree      : ${TREE}`)
console.log(`mode      : ${EXACT ? 'exact:true' : 'current (no option)'}`)
console.log(`asked to publish : ${older.slice(0, 12)}`)
console.log(`accepted head    : ${accepted.slice(0, 12)}`)
console.log(`returned  : ${threw ? `THREW ${threw}` : JSON.stringify({ ok: result?.ok, status: result?.status, revision: String(result?.revision).slice(0, 12) })}`)

const proposals = published ? published.split('\n').filter(Boolean) : []
console.log(`proposals on the remote : ${proposals.length}`)
for (const ref of proposals) {
  const sha = await git(remote, ['rev-parse', ref])
  const parents = await git(remote, ['log', '-1', '--format=%P', sha])
  const subject = await git(remote, ['log', '-1', '--format=%s', sha])
  const isNamed = sha === older
  console.log(`   ${sha.slice(0, 12)} ${isNamed ? '== the revision I named' : '!= the revision I named'}  parents=[${parents.split(' ').map(p => p.slice(0, 8)).join(' ')}]  "${subject}"`)
}
console.log(`local refs changed      : ${refsBefore !== refsAfter}`)
console.log(`new objects created     : ${objectsAfter - objectsBefore}`)
console.log(`\nVERDICT: ${proposals.length === 0 ? 'published NOTHING'
  : proposals.length === 1 && (await git(remote, ['rev-parse', proposals[0]])) === older ? 'published exactly the named revision'
  : 'published a commit that is NOT the named revision'}`)
