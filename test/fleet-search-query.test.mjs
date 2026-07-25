import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFleetSearchFilters, parseSearchQuery } from '../shared/fleet-search-query.mjs';

test('cwd: prefix becomes a project-agent search filter, not FTS text', () => {
  const parsed = parseSearchQuery('cwd:/Users/skip/work/tlda');
  const filters = buildFleetSearchFilters(parsed.filters);

  assert.equal(parsed.query, '');
  assert.equal(parsed.filters.cwd, '/Users/skip/work/tlda');
  assert.equal(filters.cwd, '/Users/skip/work/tlda');
});

test('project: prefix becomes a project-agent search filter, not FTS text', () => {
  const parsed = parseSearchQuery('project:tlda');
  const filters = buildFleetSearchFilters(parsed.filters);

  assert.equal(parsed.query, '');
  assert.equal(parsed.filters.project, 'tlda');
  assert.equal(filters.project, 'tlda');
});
