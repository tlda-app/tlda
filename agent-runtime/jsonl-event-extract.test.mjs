import assert from 'node:assert/strict'
import test from 'node:test'

import { createActivityExtractor } from './jsonl-event-extract.mjs'

function toolUse(name, input, id = 'call-1') {
  return { type: 'assistant', timestamp: '2026-09-27T10:00:00.000Z', blocks: [{ type: 'tool_use', name, input, id }] }
}

function argOf(name, input) {
  const extractor = createActivityExtractor()
  const rows = extractor.extractActivityEvents([toolUse(name, input)])
  assert.equal(rows.length, 1)
  return rows[0].arg
}

// Pane shows `Read skill read-to-the-end`; the feed row was empty.
test('read_skill arg is the skill name', () => {
  assert.equal(argOf('read_skill', { name: 'read-to-the-end' }), 'read-to-the-end')
})

// Pane renders the full todo list; the feed row carries done/total plus the
// item in progress, the most the one-line row can honestly hold.
test('write_todos arg summarizes progress and the item in progress', () => {
  assert.equal(argOf('write_todos', { todos: [
    { status: 'completed', text: 'Batch 1: land main' },
    { status: 'in_progress', text: 'Batch 2: mailbox-poll op' },
    { status: 'pending', text: 'Batch 2: land and report' },
  ] }), '1/3: Batch 2: mailbox-poll op')
})

test('write_todos arg without an item in progress is just the count', () => {
  assert.equal(argOf('write_todos', { todos: [
    { status: 'completed', text: 'Batch 1: land main' },
    { status: 'completed', text: 'Batch 2: mailbox-poll op' },
  ] }), '2/2 todos')
})

test('write_todos arg tolerates malformed todo lists', () => {
  assert.equal(argOf('write_todos', {}), '')
  assert.equal(argOf('write_todos', { todos: 'not-a-list' }), '')
})

test('write_todos arg renders a cleared list as a count', () => {
  assert.equal(argOf('write_todos', { todos: [] }), '0/0 todos')
})

// bash_input normalizes to {session, action}; the pane names the poll while
// the feed row was empty.
test('bash_input wait poll arg is the action', () => {
  assert.equal(argOf('BashOutput', { session: 'sh-1', action: 'wait for output' }), 'wait for output')
})

test('bash_input stop arg names the action', () => {
  assert.equal(argOf('BashOutput', { session: 'sh-1', action: 'stop' }), 'stop')
})

// tlda/roster takes {filter, limit}; the feed row was empty.
test('roster arg is the filter', () => {
  assert.equal(argOf('tlda/roster', { filter: 'awake', limit: 50 }), 'awake')
})

// New fallbacks sit late in the chain: established keys keep winning.
test('established arg keys still win over the new fallbacks', () => {
  assert.equal(argOf('Bash', { command: 'ls', action: 'wait for output' }), 'ls')
  assert.equal(argOf('read_skill', { description: 'x', name: 'read-to-the-end' }), 'x')
})
