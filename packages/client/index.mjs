// @tlda/client — the surface a tlda-compatible bot connects through.
//
// A bot needs three things from tlda: where the server is + a token (auth),
// a doc's assets to resolve source-line → page region, and a way to stage
// annotations (notes / highlights) into the doc room. This wraps the five
// functions that actually deliver those behind one ergonomic object:
//
//   import { connect } from '@tlda/client'
//   const tlda = connect()                 // resolves server + token from ~/.config/tlda
//   const doc  = tlda.doc('bregman')
//   await doc.stageNote(120, 'see here', { color: 'red' })
//   await doc.stageHighlight(120, 124, { color: 'red' })
//
// Disk vs remote: pass { root } to read a project's assets off disk (the tlda
// repo root); omit it to read them from the server over HTTP. Staging always
// POSTs shapes to the server.
//
// The raw functions stay exported below as the low-level escape hatch.

import { getServerUrl, getRwToken } from '../../shared/config.mjs';
import { initDataSource, readText, readJson, ensureDoc } from '../../mcp-server/data-source.mjs';
import { stageNote, stageHighlight, lookupLine, lookupLineAsync } from '../../mcp-server/lib/annotate.mjs';

export function connect({ server, token, root } = {}) {
  const resolvedServer = server || getServerUrl();
  const resolvedToken = token || getRwToken();
  // root → disk mode (read assets from <root>/server/projects); else remote over HTTP.
  initDataSource(root || null, root ? null : resolvedServer);
  return {
    server: resolvedServer,
    token: resolvedToken,
    doc: (name) => makeDoc(name, resolvedServer),
  };
}

function makeDoc(name, server) {
  return {
    name,
    stageNote: (line, text, opts = {}) => stageNote(name, line, text, { server, ...opts }),
    stageHighlight: (startLine, endLine, opts = {}) =>
      stageHighlight(name, startLine, endLine ?? startLine, { server, ...opts }),
    lookupLine: (line, file) => lookupLine(name, line, file),
    lookupLineAsync: (line, file) => lookupLineAsync(name, line, file),
    readText: (file) => readText(name, file),
    readJson: (file) => readJson(name, file),
    ensure: () => ensureDoc(name),
  };
}

// Low-level escape hatch — the underlying functions, unwrapped.
export { getServerUrl, getRwToken } from '../../shared/config.mjs';
export { initDataSource } from '../../mcp-server/data-source.mjs';
export { stageNote, stageHighlight, lookupLine } from '../../mcp-server/lib/annotate.mjs';
