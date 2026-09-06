import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { transferRegion } from './lib/region-transfer.mjs';

const { getFleetTools, handleFleetTool } = await import('./fleet-tools.mjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-region-transfer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'staging.md');
  const target = path.join(dir, 'target.txt');
  fs.writeFileSync(source, Buffer.from('unused\r\nalpha\r\nbeta\r\nunused\r\n'));
  fs.writeFileSync(target, Buffer.from('prefix\nold one\nold two\nsuffix\n'));
  return { dir, source, target };
}

test('tool schema requires a Markdown source range and exposes no inline replacement field', () => {
  const tool = getFleetTools().find(candidate => candidate.name === 'region_transfer');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, [
    'source_file', 'source_start_line', 'source_end_line',
    'target_file', 'target_start_line', 'target_end_line', 'expected',
  ]);
  assert.equal(Object.hasOwn(tool.inputSchema.properties, 'new_string'), false);
  assert.equal(tool.inputSchema.additionalProperties, false);
});

test('exported MCP dispatch joins the tool call to the atomic transfer', async t => {
  const { source, target } = fixture(t);
  const result = await handleFleetTool('region_transfer', {
    source_file: source,
    source_start_line: 2,
    source_end_line: 3,
    target_file: target,
    target_start_line: 2,
    target_end_line: 3,
    expected: 'old one\nold two',
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Transferred 11 bytes/);
  assert.deepEqual(fs.readFileSync(target), Buffer.from('prefix\nalpha\r\nbeta\nsuffix\n'));
});

test('copies source bytes and leaves every byte outside the target range unchanged', t => {
  const { dir, source, target } = fixture(t);
  const before = fs.readFileSync(target);
  const result = transferRegion({
    sourceFile: source, sourceStartLine: 2, sourceEndLine: 3,
    targetFile: target, targetStartLine: 2, targetEndLine: 3,
    expected: 'old one\nold two',
  }, { cwd: dir });
  const after = fs.readFileSync(target);
  const sourceBytes = fs.readFileSync(source).subarray(8, 19);
  assert.deepEqual(after.subarray(0, 7), before.subarray(0, 7));
  assert.deepEqual(after.subarray(7, 18), sourceBytes);
  assert.deepEqual(after.subarray(18), before.subarray(22));
  assert.equal(result.sourceBytes, 11);
});

test('stale expected text and invalid ranges leave the target unchanged', t => {
  const { dir, source, target } = fixture(t);
  const before = fs.readFileSync(target);
  assert.throws(() => transferRegion({
    sourceFile: source, sourceStartLine: 2, sourceEndLine: 3,
    targetFile: target, targetStartLine: 2, targetEndLine: 3,
    expected: 'stale',
  }, { cwd: dir }), /does not match expected/);
  assert.deepEqual(fs.readFileSync(target), before);
  assert.throws(() => transferRegion({
    sourceFile: source, sourceStartLine: 2, sourceEndLine: 99,
    targetFile: target, targetStartLine: 2, targetEndLine: 3,
    expected: 'old one\nold two',
  }, { cwd: dir }), /outside the file/);
  assert.deepEqual(fs.readFileSync(target), before);
});

test('unreadable source leaves the target unchanged', t => {
  const { dir, target } = fixture(t);
  const before = fs.readFileSync(target);
  assert.throws(() => transferRegion({
    sourceFile: path.join(dir, 'missing.md'), sourceStartLine: 1, sourceEndLine: 1,
    targetFile: target, targetStartLine: 2, targetEndLine: 3,
    expected: 'old one\nold two',
  }, { cwd: dir }), /ENOENT/);
  assert.deepEqual(fs.readFileSync(target), before);
});

test('an interruption before rename leaves the target unchanged and removes the temporary file', t => {
  const { dir, source, target } = fixture(t);
  const before = fs.readFileSync(target);
  assert.throws(() => transferRegion({
    sourceFile: source, sourceStartLine: 2, sourceEndLine: 3,
    targetFile: target, targetStartLine: 2, targetEndLine: 3,
    expected: 'old one\nold two',
  }, {
    cwd: dir,
    beforeRename: () => { throw new Error('simulated interruption'); },
  }), /simulated interruption/);
  assert.deepEqual(fs.readFileSync(target), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['staging.md', 'target.txt']);
});
