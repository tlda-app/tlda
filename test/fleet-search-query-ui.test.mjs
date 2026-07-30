import assert from 'node:assert/strict'
import test from 'node:test'

import { groupFleetSearchResults, rankSearchResults } from '../shared/fleet-search-query.mjs'

test('multimodal search ranking keeps conversation ahead of low-specificity document and session echoes', () => {
  const rows = [
    {
      source: 'project',
      type: 'document_content',
      id: 'document:old-report',
      score: 24,
      timestamp: '2026-07-28T00:00:00.000Z',
      text: 'Skip search appears in a broad archived report list.',
    },
    {
      source: 'session',
      role: 'user',
      id: 'session-echo',
      timestamp: '2026-07-30T11:00:00.000Z',
      text: 'Skip search appeared in an inbox echo.',
    },
    {
      source: 'fleet',
      type: 'chat',
      id: 'chat-answer',
      timestamp: '2026-07-29T11:00:00.000Z',
      text: 'Skip search ranking needs the direct conversation first.',
    },
  ]

  const ranked = rankSearchResults(rows, 'Skip search')
  assert.equal(ranked[0].id, 'chat-answer')
  assert.equal(ranked[1].id, 'document:old-report')
  assert.equal(ranked[2].id, 'session-echo')

  const groups = groupFleetSearchResults(ranked)
  assert.deepEqual(groups.map(group => group.id), ['conversation', 'documents', 'sessions'])
  assert.deepEqual(groups.map(group => group.results.map(row => row.id)), [
    ['chat-answer'],
    ['document:old-report'],
    ['session-echo'],
  ])
})
