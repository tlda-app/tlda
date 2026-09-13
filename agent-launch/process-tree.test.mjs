import assert from 'node:assert/strict'
import test from 'node:test'
import { parseProcessTree, soleOwnedRuntime, walkSubtree } from './process-tree.mjs'

// `ps -eo pid,ppid,args` output. Pane 100 owns a shell, which owns the
// runtime, which owns its MCP child -- the real shape, three levels deep,
// because the MCP-child check in runtimeStateFromProcessList only works if the
// walk descends past the runtime.
const PS = [
  '  100     1 -zsh',
  '  200   100 /Users/x/.local/bin/muse-bin-1.1.1-R2514.1 --model m --workspace /w',
  '  300   200 node /Users/x/work/tlda/mcp-server/index.mjs',
  '  400     1 /Users/x/.local/bin/muse-bin-1.1.1-R2514.1 --model m --workspace /elsewhere',
].join('\n')

const MUSE = /(?:^|\s|[/\\])muse(?:-bin-[\w.-]+)?(?:\.exe)?(?:\s|$)/

test('the tree links children to parents and keeps each pid argv', () => {
  const { children, argsByPid } = parseProcessTree(PS)
  assert.deepEqual(children.get('100'), ['200'])
  assert.deepEqual(children.get('200'), ['300'])
  assert.equal(children.get('300'), undefined)
  assert.match(argsByPid.get('200'), /muse-bin/)
  // Trimmed, so a consumer regex anchored on `(?:\s|$)` sees the same string
  // whatever leading padding `ps` used for the pid column.
  assert.equal(argsByPid.get('100'), '-zsh')
})

test('the walk descends the whole subtree and excludes everything outside it', () => {
  const { children } = parseProcessTree(PS)
  const visited = walkSubtree(['100'], children)
  assert.deepEqual(visited, ['100', '200', '300'])
  // 400 is a muse runtime in another pane. A walk that returned it would let
  // one pane claim another pane's session.
  assert.ok(!visited.includes('400'))
})

test('a pid is visited once even when the tree points back at itself', () => {
  const { children } = parseProcessTree(['  10     1 a', '  11    10 b', '  10    11 a'].join('\n'))
  const visited = walkSubtree(['10'], children)
  assert.equal(new Set(visited).size, visited.length)
})

// Traversal order is part of the contract: runtimeStateFromProcessList returns
// the FIRST match rather than requiring uniqueness, so the order decides its
// answer. This pins the LIFO shape all four copies had.
test('siblings are visited last-pushed-first, which is what the first-match caller depends on', () => {
  const { children } = parseProcessTree(['  1     0 root', '  2     1 first', '  3     1 second'].join('\n'))
  assert.deepEqual(walkSubtree(['1'], children), ['1', '3', '2'])
})

test('exactly one owned runtime, or nothing', () => {
  const one = soleOwnedRuntime(['100'], PS, args => MUSE.test(args))
  assert.equal(one.pid, '200')
  assert.match(one.args, /--workspace \/w/)

  // Two under one pane: the pane is not evidence about which session belongs
  // to this agent, so the answer is nothing rather than either of them.
  const two = `${PS}\n  500   200 /Users/x/.local/bin/muse-bin-1.1.1-R2514.1 --model m --workspace /w2`
  assert.equal(soleOwnedRuntime(['100'], two, args => MUSE.test(args)), null)

  assert.equal(soleOwnedRuntime(['100'], PS, () => false), null, 'no match is nothing')
  assert.equal(soleOwnedRuntime([], PS, args => MUSE.test(args)), null, 'no pane pids is nothing')
})

test('unparseable ps output yields an empty tree rather than throwing', () => {
  // `ps` blowing its timeout hands the caller a partial or empty string. That
  // has to be "I found nothing", never a crash on the mint-and-wake path.
  //
  // The matcher is the real one on purpose. A pane pid with no row in `ps` is
  // still VISITED -- the walk starts from the roots it was given -- and it is
  // tested against argv of `''`. So `soleOwnedRuntime(['100'], '', () => true)`
  // returns that pane pid, which looks like a bug and is not: every copy this
  // module replaced did exactly the same, verified against the original walk
  // from 73685a020. What keeps it harmless is that no harness regex matches
  // the empty string. A matcher that did would have been broken before this
  // module existed.
  for (const bad of ['', null, undefined, 'ps: command not found']) {
    const { children, argsByPid } = parseProcessTree(bad)
    assert.equal(children.size, 0)
    assert.equal(argsByPid.size, 0)
    assert.equal(soleOwnedRuntime(['100'], bad, args => MUSE.test(args)), null)
  }
})
