/**
 * Unit tests for parseTimestamp().
 * Usage: node --test test/parse-timestamp.test.mjs
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { parseTimestamp } from '../mcp-server/lib/parse-timestamp.mjs'

describe('parseTimestamp', () => {
  const FAKE_NOW = new Date('2026-05-09T12:00:00.000Z').getTime();
  const origNow = Date.now;

  before(() => { Date.now = () => FAKE_NOW; });
  after(() => { Date.now = origNow; });

  it('passes through null/undefined', () => {
    assert.equal(parseTimestamp(null), null);
    assert.equal(parseTimestamp(undefined), undefined);
  });

  it('"now" resolves to current time', () => {
    assert.equal(parseTimestamp('now'), new Date(FAKE_NOW).toISOString());
    assert.equal(parseTimestamp('NOW'), new Date(FAKE_NOW).toISOString());
  });

  it('relative minutes', () => {
    const expected = new Date(FAKE_NOW - 20 * 60_000).toISOString();
    assert.equal(parseTimestamp('20m'), expected);
    assert.equal(parseTimestamp('-20m'), expected);
    assert.equal(parseTimestamp('20min'), expected);
    assert.equal(parseTimestamp('20minutes'), expected);
  });

  it('relative hours', () => {
    const expected = new Date(FAKE_NOW - 2 * 3_600_000).toISOString();
    assert.equal(parseTimestamp('2h'), expected);
    assert.equal(parseTimestamp('-2h'), expected);
    assert.equal(parseTimestamp('2hr'), expected);
    assert.equal(parseTimestamp('2hours'), expected);
  });

  it('relative days', () => {
    const expected = new Date(FAKE_NOW - 1 * 86_400_000).toISOString();
    assert.equal(parseTimestamp('1d'), expected);
    assert.equal(parseTimestamp('-1d'), expected);
    assert.equal(parseTimestamp('1day'), expected);
    assert.equal(parseTimestamp('1days'), expected);
  });

  it('ISO string passes through unchanged', () => {
    const iso = '2026-05-01T00:00:00.000Z';
    assert.equal(parseTimestamp(iso), iso);
  });

  it('unrecognized strings pass through unchanged', () => {
    assert.equal(parseTimestamp('yesterday'), 'yesterday');
    assert.equal(parseTimestamp('invalid'), 'invalid');
  });
});
