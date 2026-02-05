#!/usr/bin/env node
/**
 * MCP Server for TLDraw Feedback
 *
 * Provides:
 * - HTTP endpoint to receive snapshots from Share button
 * - MCP tools to wait for / check feedback
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import http from 'http';
import fs from 'fs';
import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import * as Y from 'yjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_PATH = '/tmp/tldraw-snapshot.json';
const SCREENSHOT_PATH = '/tmp/annotated-view.png';

// ---- Lookup.json support ----

const lookupCache = new Map();

function loadLookup(docName) {
  if (lookupCache.has(docName)) return lookupCache.get(docName);
  const lookupPath = path.join(PROJECT_ROOT, 'public', 'docs', docName, 'lookup.json');
  if (!fs.existsSync(lookupPath)) {
    lookupCache.set(docName, null);
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(lookupPath, 'utf8'));
    lookupCache.set(docName, data);
    return data;
  } catch {
    lookupCache.set(docName, null);
    return null;
  }
}

function lookupLine(docName, lineNum) {
  const lookup = loadLookup(docName);
  if (!lookup?.lines) return null;
  const entry = lookup.lines[lineNum.toString()];
  if (!entry) return null;
  return { page: entry.page, x: entry.x, y: entry.y, content: entry.content, texFile: lookup.meta?.texFile };
}

// PDF → canvas coordinate conversion (matching synctexAnchor.ts)
const PDF_WIDTH = 612;
const PDF_HEIGHT = 792;
const VIEWBOX_OFFSET = -72;
const PAGE_WIDTH = 800;
const PAGE_HEIGHT = 1035.294; // 792 * (800/612)
const PAGE_GAP = 20;

function pdfToCanvas(page, pdfX, pdfY) {
  const pageY = (page - 1) * (PAGE_HEIGHT + PAGE_GAP);
  const scaleX = PAGE_WIDTH / PDF_WIDTH;
  const scaleY = PAGE_HEIGHT / PDF_HEIGHT;
  return {
    x: (pdfX - VIEWBOX_OFFSET) * scaleX,
    y: pageY + (pdfY - VIEWBOX_OFFSET) * scaleY,
  };
}

// ---- Yjs connection management ----

const SYNC_SERVER = process.env.SYNC_SERVER || 'ws://localhost:5176';
const yjsDocs = new Map(); // docName → { doc, yRecords, ws, ready }

function connectYjs(docName) {
  if (yjsDocs.has(docName)) {
    const entry = yjsDocs.get(docName);
    if (entry.ready) return Promise.resolve(entry);
    return entry.promise;
  }

  const doc = new Y.Doc();
  const yRecords = doc.getMap('tldraw');
  const roomId = `doc-${docName}`;

  const entry = { doc, yRecords, ws: null, ready: false };

  entry.promise = new Promise((resolve, reject) => {
    const ws = new WsClient(`${SYNC_SERVER}/${roomId}`);
    entry.ws = ws;

    const timeout = setTimeout(() => {
      reject(new Error('Yjs connection timeout'));
      ws.close();
    }, 10000);

    ws.on('open', () => {
      console.error(`[Yjs] Connected to ${roomId}`);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'sync') {
          Y.applyUpdate(doc, new Uint8Array(msg.data));
          entry.ready = true;
          clearTimeout(timeout);
          console.error(`[Yjs] Synced ${yRecords.size} records for ${docName}`);
          resolve(entry);
        } else if (msg.type === 'update') {
          Y.applyUpdate(doc, new Uint8Array(msg.data));
        }
      } catch (e) {
        console.error('[Yjs] Message error:', e.message);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Yjs connection error: ${err.message}`));
    });

    ws.on('close', () => {
      console.error(`[Yjs] Disconnected from ${roomId}`);
      yjsDocs.delete(docName);
    });
  });

  yjsDocs.set(docName, entry);
  return entry.promise;
}

function sendYjsUpdate(entry) {
  if (entry.ws?.readyState === WsClient.OPEN) {
    const update = Y.encodeStateAsUpdate(entry.doc);
    entry.ws.send(JSON.stringify({ type: 'update', data: Array.from(update) }));
  }
}

function generateShapeId() {
  return 'shape:' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
}

// Track snapshot state
let lastSnapshotTime = 0;
let waitingResolvers = [];
let lastRenderOutput = ''; // Capture viewer output for MCP tools

// Render snapshot to screenshot
async function renderSnapshot() {
  return new Promise((resolve, reject) => {
    const viewer = spawn('node', [path.join(PROJECT_ROOT, 'view-snapshot.mjs')], {
      cwd: PROJECT_ROOT,
    });

    let output = '';
    viewer.stdout.on('data', (data) => output += data);
    viewer.stderr.on('data', (data) => output += data);

    viewer.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Viewer exited with code ${code}: ${output}`));
      }
    });
  });
}

// HTTP server for receiving snapshots
const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/snapshot') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        fs.writeFileSync(SNAPSHOT_PATH, body);
        lastSnapshotTime = Date.now();

        // Auto-render and capture output
        try {
          lastRenderOutput = await renderSnapshot();
          fs.writeFileSync('/tmp/tldraw-render-output.txt', lastRenderOutput);
        } catch (e) {
          lastRenderOutput = `Render error: ${e.message}`;
          fs.writeFileSync('/tmp/tldraw-render-output.txt', lastRenderOutput);
        }

        // Notify any waiting resolvers
        const resolvers = waitingResolvers;
        waitingResolvers = [];
        resolvers.forEach(resolve => resolve());

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Forward sync: just scroll (no marker)
  if (req.method === 'POST' && req.url === '/scroll') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { x, y } = JSON.parse(body);
        const message = JSON.stringify({ type: 'scroll', x, y });
        for (const client of wsClients) {
          if (client.readyState === 1) client.send(message);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clients: wsClients.size }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Forward sync: highlight a location in TLDraw
  if (req.method === 'POST' && req.url === '/highlight') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { x, y, page } = JSON.parse(body);
        console.error(`Highlighting: page ${page}, coords (${x}, ${y})`);
        broadcastHighlight(x, y, page);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clients: wsClients.size }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Forward sync: send a note (text) to TLDraw
  if (req.method === 'POST' && req.url === '/note') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { x, y, text } = JSON.parse(body);
        console.error(`Note at (${x}, ${y}): ${text.slice(0, 50)}...`);
        broadcastNote(x, y, text);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clients: wsClients.size }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Forward sync: reply to an existing note
  if (req.method === 'POST' && req.url === '/reply') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { shapeId, text } = JSON.parse(body);
        console.error(`Reply to ${shapeId}: ${text.slice(0, 50)}...`);
        broadcastReply(shapeId, text);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clients: wsClients.size }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// Start HTTP server
const HTTP_PORT = 5174;
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.error(`Feedback HTTP server running on port ${HTTP_PORT}`);
});

// WebSocket server for forward sync (Claude → iPad)
const WS_PORT = 5175;
const wss = new WebSocketServer({ port: WS_PORT });
const wsClients = new Set();

wss.on('connection', (ws) => {
  console.error('TLDraw client connected via WebSocket');
  wsClients.add(ws);

  ws.on('close', () => {
    wsClients.delete(ws);
    console.error('TLDraw client disconnected');
  });
});

console.error(`WebSocket server running on port ${WS_PORT}`);

// Broadcast highlight to all connected TLDraw clients
function broadcastHighlight(tldrawX, tldrawY, page) {
  const message = JSON.stringify({
    type: 'highlight',
    x: tldrawX,
    y: tldrawY,
    page,
  });
  for (const client of wsClients) {
    if (client.readyState === 1) { // OPEN
      client.send(message);
    }
  }
}

// Broadcast note (text) to all connected TLDraw clients
function broadcastNote(tldrawX, tldrawY, text) {
  const message = JSON.stringify({
    type: 'note',
    x: tldrawX,
    y: tldrawY,
    text,
  });
  for (const client of wsClients) {
    if (client.readyState === 1) { // OPEN
      client.send(message);
    }
  }
}

// Broadcast reply (append to existing note)
function broadcastReply(shapeId, text) {
  const message = JSON.stringify({
    type: 'reply',
    shapeId,
    text,
  });
  for (const client of wsClients) {
    if (client.readyState === 1) { // OPEN
      client.send(message);
    }
  }
}

// MCP Server
const server = new Server(
  { name: 'tldraw-feedback', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'wait_for_feedback',
      description: 'Wait for feedback from the iPad. Blocks until user hits Share, then returns screenshot path and annotation summary.',
      inputSchema: {
        type: 'object',
        properties: {
          timeout: {
            type: 'number',
            description: 'Max seconds to wait (default: 300)',
          },
        },
      },
    },
    {
      name: 'check_feedback',
      description: 'Check if there is new feedback since last check. Non-blocking.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_latest_feedback',
      description: 'Get the latest feedback screenshot, regardless of whether it is new.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'highlight_location',
      description: 'Highlight a location in the TLDraw canvas on the iPad. Use this for forward sync from TeX source to iPad.',
      inputSchema: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'Path to the TeX file',
          },
          line: {
            type: 'number',
            description: 'Line number in the TeX file',
          },
        },
        required: ['file', 'line'],
      },
    },
    {
      name: 'add_annotation',
      description: 'Add a math note annotation to the document at a specific source line. The note appears in the TLDraw canvas and syncs to all viewers.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          line: { type: 'number', description: 'Source line number to anchor the note to' },
          text: { type: 'string', description: 'Note content (supports $math$ and $$display math$$)' },
          color: { type: 'string', description: 'Note color: yellow, red, green, blue, violet, orange, grey (default: violet)' },
          width: { type: 'number', description: 'Note width in pixels (default: 200)' },
          height: { type: 'number', description: 'Note height in pixels (default: 150)' },
        },
        required: ['doc', 'line', 'text'],
      },
    },
    {
      name: 'list_annotations',
      description: 'List all annotations in a document.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
        },
        required: ['doc'],
      },
    },
    {
      name: 'delete_annotation',
      description: 'Delete an annotation by its shape ID.',
      inputSchema: {
        type: 'object',
        properties: {
          doc: { type: 'string', description: 'Document name (e.g. "bregman")' },
          id: { type: 'string', description: 'Shape ID (e.g. "shape:abc123")' },
        },
        required: ['doc', 'id'],
      },
    },
  ],
}));

// Track last checked time for check_feedback
let lastCheckedTime = 0;

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'wait_for_feedback') {
    const timeout = (args?.timeout || 300) * 1000;

    // Wait for new snapshot
    const waitPromise = new Promise(resolve => {
      waitingResolvers.push(resolve);
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Timeout waiting for feedback')), timeout);
    });

    try {
      await Promise.race([waitPromise, timeoutPromise]);

      // Return the viewer output (includes diff info and screenshot paths)
      return {
        content: [{
          type: 'text',
          text: `New feedback received!\n\n${lastRenderOutput}`,
        }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  }

  if (name === 'check_feedback') {
    if (lastSnapshotTime > lastCheckedTime) {
      lastCheckedTime = Date.now();
      return {
        content: [{
          type: 'text',
          text: `New feedback available!\n\n${lastRenderOutput}`,
        }],
      };
    } else {
      return {
        content: [{ type: 'text', text: 'No new feedback since last check.' }],
      };
    }
  }

  if (name === 'get_latest_feedback') {
    if (!fs.existsSync(SCREENSHOT_PATH)) {
      return {
        content: [{ type: 'text', text: 'No feedback screenshot available.' }],
      };
    }
    const summary = await getAnnotationSummary();
    return {
      content: [{
        type: 'text',
        text: `Latest feedback:\n\n${summary}\n\nScreenshot: ${SCREENSHOT_PATH}`,
      }],
    };
  }

  if (name === 'highlight_location') {
    const { file, line } = args;
    if (!file || !line) {
      return {
        content: [{ type: 'text', text: 'Missing file or line parameter' }],
        isError: true,
      };
    }

    // Try lookup.json first (works without synctex binary)
    // Guess doc name from file path
    const docName = path.basename(file, '.tex').replace(/-lower-bound$/, '').replace(/^\.\//, '');
    const knownDocs = ['bregman']; // extend as needed
    const doc = knownDocs.find(d => file.includes(d)) || docName;

    const linePos = lookupLine(doc, line);
    if (linePos) {
      const canvasPos = pdfToCanvas(linePos.page, linePos.x, linePos.y);
      broadcastHighlight(canvasPos.x, canvasPos.y, linePos.page);
      return {
        content: [{
          type: 'text',
          text: `Highlighted page ${linePos.page} at (${canvasPos.x.toFixed(0)}, ${canvasPos.y.toFixed(0)})`,
        }],
      };
    }

    // Fall back to synctex-reverse.mjs
    try {
      const result = execSync(
        `node "${path.join(PROJECT_ROOT, 'synctex-reverse.mjs')}" "${file}" ${line}`,
        { encoding: 'utf8', cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const jsonMatch = result.match(/JSON: ({.*})/);
      if (jsonMatch) {
        const coords = JSON.parse(jsonMatch[1]);
        broadcastHighlight(coords.tldrawX, coords.tldrawY, coords.page);
        return {
          content: [{
            type: 'text',
            text: `Highlighted page ${coords.page} at (${coords.tldrawX.toFixed(0)}, ${coords.tldrawY.toFixed(0)})`,
          }],
        };
      }
      return {
        content: [{ type: 'text', text: 'Could not find location in PDF' }],
        isError: true,
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Line ${line} not found in lookup or synctex` }],
        isError: true,
      };
    }
  }

  if (name === 'add_annotation') {
    const { doc, line, text, color = 'violet', width = 200, height = 150 } = args;
    if (!doc || !line || !text) {
      return { content: [{ type: 'text', text: 'Missing required parameters: doc, line, text' }], isError: true };
    }

    // Look up position from lookup.json
    const linePos = lookupLine(doc, line);
    if (!linePos) {
      return { content: [{ type: 'text', text: `Line ${line} not found in lookup.json for doc "${doc}"` }], isError: true };
    }

    const canvasPos = pdfToCanvas(linePos.page, linePos.x, linePos.y);
    const x = Math.min(canvasPos.x + 100, PAGE_WIDTH - width - 20);
    const y = canvasPos.y - height / 2;

    // Connect to Yjs and create the shape
    try {
      const entry = await connectYjs(doc);
      const shapeId = generateShapeId();
      const shape = {
        id: shapeId,
        type: 'math-note',
        typeName: 'shape',
        x, y,
        rotation: 0,
        isLocked: false,
        opacity: 1,
        props: { w: width, h: height, text, color },
        meta: {
          sourceAnchor: {
            file: `./${linePos.texFile || doc + '.tex'}`,
            line,
            column: -1,
            content: linePos.content,
          },
        },
        parentId: 'page:page',
        index: 'a1',
      };

      entry.doc.transact(() => {
        entry.yRecords.set(shapeId, shape);
      });
      sendYjsUpdate(entry);

      return {
        content: [{
          type: 'text',
          text: `Created annotation ${shapeId}\n  line ${line} → page ${linePos.page}, canvas (${x.toFixed(0)}, ${y.toFixed(0)})\n  text: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`,
        }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Yjs error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'list_annotations') {
    const { doc } = args;
    if (!doc) {
      return { content: [{ type: 'text', text: 'Missing required parameter: doc' }], isError: true };
    }

    try {
      const entry = await connectYjs(doc);
      const annotations = [];

      entry.yRecords.forEach((record, id) => {
        if (record.type === 'math-note') {
          const anchor = record.meta?.sourceAnchor;
          annotations.push({
            id,
            x: Math.round(record.x),
            y: Math.round(record.y),
            color: record.props?.color,
            text: record.props?.text || '',
            anchor: anchor ? `${anchor.file}:${anchor.line}` : null,
            content: anchor?.content || null,
          });
        }
      });

      if (annotations.length === 0) {
        return { content: [{ type: 'text', text: 'No annotations found.' }] };
      }

      let summary = `${annotations.length} annotation(s):\n\n`;
      annotations.forEach((a, i) => {
        summary += `${i + 1}. ${a.id}\n`;
        summary += `   pos: (${a.x}, ${a.y}) color: ${a.color}\n`;
        if (a.anchor) summary += `   anchor: ${a.anchor}\n`;
        summary += `   text: "${a.text.slice(0, 80)}${a.text.length > 80 ? '...' : ''}"\n\n`;
      });

      return { content: [{ type: 'text', text: summary }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Yjs error: ${e.message}` }], isError: true };
    }
  }

  if (name === 'delete_annotation') {
    const { doc, id } = args;
    if (!doc || !id) {
      return { content: [{ type: 'text', text: 'Missing required parameters: doc, id' }], isError: true };
    }

    const fullId = id.startsWith('shape:') ? id : `shape:${id}`;

    try {
      const entry = await connectYjs(doc);
      if (!entry.yRecords.has(fullId)) {
        return { content: [{ type: 'text', text: `Annotation not found: ${fullId}` }], isError: true };
      }

      entry.doc.transact(() => {
        entry.yRecords.delete(fullId);
      });
      sendYjsUpdate(entry);

      return { content: [{ type: 'text', text: `Deleted: ${fullId}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Yjs error: ${e.message}` }], isError: true };
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// Run synctex lookup for a single TLDraw coordinate
function synctexLookupCoord(x, y) {
  try {
    const result = execSync(
      `node "${path.join(PROJECT_ROOT, 'synctex-lookup.mjs')}" ${x} ${y}`,
      { encoding: 'utf8', cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    // Parse the JSON output at the end
    const jsonMatch = result.match(/JSON: ({.*})/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function getAnnotationSummary() {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    return 'No snapshot file found.';
  }

  try {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    const annotations = [];

    for (const [id, record] of Object.entries(snapshot.store || {})) {
      if (record.typeName === 'shape' && record.type !== 'image') {
        const ann = {
          type: record.type,
          x: Math.round(record.x),
          y: Math.round(record.y),
          color: record.props?.color,
        };

        // Look up TeX source location
        const lookup = synctexLookupCoord(record.x, record.y);
        if (lookup) {
          ann.source = {
            file: lookup.file,
            line: lookup.line,
            page: lookup.page,
          };
        }

        annotations.push(ann);
      }
    }

    if (annotations.length === 0) {
      return 'No annotations found.';
    }

    let summary = `Found ${annotations.length} annotation(s):\n`;
    annotations.forEach((a, i) => {
      const colorStr = a.color ? ` (${a.color})` : '';
      summary += `  ${i + 1}. ${a.type}${colorStr} at (${a.x}, ${a.y})`;
      if (a.source) {
        const relPath = path.relative(PROJECT_ROOT, a.source.file);
        summary += `\n     → ${relPath}:${a.source.line}`;
        summary += `\n     → texsync://file${a.source.file}:${a.source.line}`;
      }
      summary += '\n';
    });

    return summary;
  } catch (e) {
    return `Error reading snapshot: ${e.message}`;
  }
}

// Start MCP server
const transport = new StdioServerTransport();
server.connect(transport);
console.error('TLDraw Feedback MCP server started');
