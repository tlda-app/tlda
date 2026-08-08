import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { fleetFetch } from '../mcp-server/fleet-tools.mjs';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withSlowServer(delayMs, fn) {
  const server = http.createServer(async (req, res) => {
    await delay(delayMs);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/slow`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('fleetFetch without an explicit timeout survives beyond two seconds', async () => {
  await withSlowServer(2200, async url => {
    const started = Date.now();
    const res = await fleetFetch(url);
    const elapsed = Date.now() - started;

    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.ok(elapsed >= 2000, `request completed before two seconds elapsed: ${elapsed}ms`);
  });
});

test('fleetFetch honors an explicit caller supplied timeout', async () => {
  await withSlowServer(300, async url => {
    const started = Date.now();
    await assert.rejects(
      fleetFetch(url, { signal: AbortSignal.timeout(50) }),
      error => error?.name === 'TimeoutError' || error?.name === 'AbortError'
    );
    assert.ok(Date.now() - started < 250, 'explicit timeout did not abort before the delayed response');
  });
});
