#!/usr/bin/env node
// What has not reached the paper, and how long it has been waiting.
//
// Skip, 2026-08-13, on what this domain is judged by: "the goal is to not lose
// fucking data." Git is the floor — anything that reached the remote or the
// shadow history comes back — so the only losable edit is one that never got
// there. This is the read side of the ledger that reports those.
//
// The alarm is age rather than error, because the same entry means different
// things an hour apart: a conflict a minute old is two people working, and the
// same conflict at breakfast is somebody's paragraph that has spent the night
// in exactly one place.

import assert from 'node:assert/strict'

import { describeStuckEntry, sourceSyncLedger, sourceSyncIsStale, staleSourceSyncEntries } from '../server/lib/source-sync-conflicts.mjs'

const MINUTE = 60_000
const now = Date.parse('2026-08-13T09:00:00.000Z')
const ago = ms => new Date(now - ms).toISOString()

const conflict = (file, at, who = 'alice-laptop') => ({
  file, at, source: 'source-authority', owner: { machineId: who },
})

// ## A paper nobody is stuck on

// ### Nothing has been refused
const quiet = sourceSyncLedger({ sourceSyncConflicts: [] }, now)
assert.deepEqual(quiet.entries, [],
  'the ledger — is empty; otherwise something is waiting and this story is about a paper where nothing is')
assert.equal(quiet.oldestWaitingMs, 0,
  'the oldest thing waiting — is nothing at all')
assert.equal(sourceSyncIsStale(quiet, 30 * MINUTE), false,
  'the paper — raises nothing, because nobody is stuck')

// ## Two people working, and one person stuck since last night

// ### Alice was refused a minute ago and Bob nine hours ago
const ledger = sourceSyncLedger({
  sourceSyncConflicts: [conflict('intro.tex', ago(MINUTE)), conflict('method.tex', ago(9 * 60 * MINUTE), 'bob-desktop')],
}, now)

assert.equal(ledger.entries.length, 2,
  'the ledger — holds both people; otherwise one of them is invisible and that is the failure this exists to stop')
assert.equal(ledger.entries[0].file, 'method.tex',
  "the longest wait — is first, because one stuck edit matters more than five fresh ones")
assert.equal(ledger.entries[0].owner.machineId, 'bob-desktop',
  "the stuck edit — is named to a machine, so it says whose work is in one place")
assert.equal(ledger.oldestWaitingMs, 9 * 60 * MINUTE,
  'the oldest thing waiting — is nine hours old')

// ### A threshold anyone would set catches Bob and not Alice
assert.equal(sourceSyncIsStale(ledger, 30 * MINUTE), true,
  'the paper — raises, because somebody has been stuck since last night')
assert.equal(sourceSyncIsStale(sourceSyncLedger({ sourceSyncConflicts: [conflict('intro.tex', ago(MINUTE))] }, now), 30 * MINUTE), false,
  'a minute-old conflict — raises nothing, because that is two people working rather than a fault')

// ## An entry whose age cannot be read is stuck, not fine

// ### The timestamp is unreadable
const broken = sourceSyncLedger({ sourceSyncConflicts: [conflict('main.tex', 'not a date')] }, now)
assert.equal(broken.entries[0].waitingMs, null,
  'an unreadable timestamp — reports no age rather than an age of zero')
assert.equal(broken.unknownAge, 1,
  'the ledger — counts how many it could not age, so the gap is visible rather than absorbed')
assert.equal(sourceSyncIsStale(broken, 30 * MINUTE), true,
  'the paper — raises anyway; otherwise an instrument that cannot see the failing case would report health, '
  + 'which is the exact way our sync telemetry claimed "online" through eight server restarts')

// ## Across every paper at once, because that is the question somebody asks
//
// A ledger nobody reads is not an instrument, and nothing writes at the moment
// an edit becomes old, so something has to look at the clock. The sweep is that
// — kept pure here, with its caller deciding how often and what to say.

const papers = [
  { name: 'quiet-paper', sourceSyncConflicts: [] },
  { name: 'balancing-act', sourceSyncConflicts: [conflict('intro.tex', ago(MINUTE))] },
  {
    name: 'eiv-paper',
    sourceSyncConflicts: [conflict('method.tex', ago(9 * 60 * MINUTE), 'bob-desktop')],
    sourceSyncRefusals: [{
      status: 'refused', file: 'refs.bib', at: ago(2 * 60 * MINUTE),
      owner: { participant: 'the live editor' }, reason: 'the paper is being rebuilt',
    }],
  },
]

// ### The worst thing anywhere is the first thing said
const stuck = staleSourceSyncEntries(papers, 30 * MINUTE, now)
assert.deepEqual(stuck.map(entry => [entry.project, entry.file]),
  [['eiv-paper', 'method.tex'], ['eiv-paper', 'refs.bib']],
  'the sweep — reports the nine-hour wait before the two-hour one, and reports them across papers rather '
  + 'than per paper, because the question is what is worst rather than what is where')

// ### A minute-old conflict is not news, in any paper
assert.equal(stuck.some(entry => entry.project === 'balancing-act'), false,
  'the minute-old conflict — is not reported, because two people working is not a fault')
assert.equal(stuck.some(entry => entry.project === 'quiet-paper'), false,
  'the paper nobody is stuck on — says nothing at all, so silence means silence')

// ### An entry with no readable age is reported even in a paper that is otherwise fresh
const ageless = staleSourceSyncEntries(
  [{ name: 'eiv-paper', sourceSyncConflicts: [conflict('intro.tex', ago(MINUTE)), conflict('main.tex', 'not a date')] }],
  30 * MINUTE, now)
assert.deepEqual(ageless.map(entry => entry.file), ['main.tex'],
  'the unreadable entry — is reported and the fresh one beside it is not; otherwise the thing nobody can '
  + 'say is fine gets averaged in with the thing that is')

// ### It says a sentence rather than a shape
assert.equal(describeStuckEntry(stuck[0]),
  'bob-desktop has been holding method.tex in eiv-paper for 540 minutes',
  'the line — names who, what, where and how long, because a person reads this and a shape has to be decoded')
assert.equal(describeStuckEntry(ageless[0]),
  'alice-laptop has been holding main.tex in eiv-paper for an unknown length of time, because its timestamp cannot be read',
  'the unreadable one — says why it has no age rather than reporting a number nobody should trust')

console.log('what has not reached the paper: the ledger reports it, oldest first, and cannot report health blindly')
