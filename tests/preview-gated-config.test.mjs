import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// `tlda-dev serve --gated` writes the preview's server.yaml.
//
// The failure this guards is silent in the worst way: if the gated preview
// writes tokens into the environment but not `tokenGating` into the config,
// `validateToken` answers 'rw' for every caller and `classroomPrincipal`
// short-circuits to instructor before an enrolment token is ever read. Every
// student-facing check then passes — as an instructor. Green, and measuring
// nothing.
//
// Read as source rather than executed: `cmdServeWorktree` builds a git worktree,
// picks a port and detaches a server, none of which belongs in a unit test. What
// is checked is the config contract those lines encode.

const source = readFileSync(new URL('../cli/lib/dev-worktree.mjs', import.meta.url), 'utf8')

test('a gated preview turns gating on in the config, not just in the environment', () => {
  assert.match(source, /serverYaml\.push\('tokenGating: true'\)/,
    'the gated preview does not write tokenGating; the env tokens alone leave every caller rw')
  assert.match(source, /serverYaml\.push\('tokensFromEnvironmentOnly: true'\)/,
    "the preview may fall back to this machine's real tokens")
})

test('gating is off unless asked for', () => {
  // Default must stay exactly as it was: every existing preview is unchanged.
  assert.match(source, /const tokens = flags\.has\('gated'\) \? previewTokens\(\) : null/,
    'gating is no longer opt-in')
  assert.match(source, /writePreviewConfig\(branch, base, \{ realFleet, tokens \}\)/,
    'the config writer no longer receives the tokens')
})

test('the config is written on every start, because a stop deletes it', () => {
  // `tlda-dev serve stop` removes the preview's config dir. A gated preview that
  // wrote its config once would work exactly one run and then silently fall back
  // to ungated — the same invisible failure, arriving later.
  const serve = source.slice(source.indexOf('export async function cmdServeWorktree'))
  assert.ok(
    serve.indexOf('writePreviewConfig(') > -1,
    'serve does not write the preview config at all',
  )
  assert.doesNotMatch(serve.slice(0, serve.indexOf('writePreviewConfig(')), /existsSync\(previewConfigDir/,
    'the config write looks conditional on the directory already existing',
  )
})

test('the tokens are printed, and fresh per run', () => {
  assert.match(source, /read token \(a reader\)/, 'the read token is never printed')
  assert.match(source, /rw token\s+\(an instructor\)/, 'the rw token is never printed')
  // Fresh per run rather than stable: nothing persists across a stop anyway, and
  // a preview must never hand out this machine's real tokens.
  assert.match(source, /randomBytes\(24\)\.toString\('base64url'\)/,
    'preview tokens are not randomly generated')
})

test('the URL that gets printed and shared actually opens', () => {
  // A gated preview whose printed URL carries no token is a 401 and half an hour
  // of working out why. Both the startup print and `tlda-dev share` must carry it.
  const serve = source.slice(source.indexOf('export async function cmdServeWorktree'), source.indexOf('export async function cmdShareWorktree'))
  const share = source.slice(source.indexOf('export async function cmdShareWorktree'))
  assert.match(serve, /token=\$\{tokens\.read\}/, 'the startup URL carries no token')
  assert.match(share, /token=\$\{m\.tokens\.read\}/, 'tlda-dev share prints a URL that will 401')
})
