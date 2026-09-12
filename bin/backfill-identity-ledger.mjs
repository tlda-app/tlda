#!/usr/bin/env node
/**
 * Scan all Claude JSONL session files and backfill the fleet identity ledger
 * with fleet IDs and session UUIDs found in tool_result messages.
 *
 * Usage: node bin/backfill-identity-ledger.mjs [--dry-run]
 */

import { createReadStream } from 'fs';
import { readdir, stat } from 'fs/promises';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { ledger } from '../mcp-server/identity.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const PROJECTS_BASE = join(homedir(), '.claude', 'projects');

// Convert project dir name back to cwd path
// e.g. "-Users-skip-work-tlda" → "/Users/skip/work/tlda"
function dirToCwd(dirName) {
  if (!dirName || dirName === '-') return null;
  // Replace leading - and all - with /
  return '/' + dirName.slice(1).replace(/-/g, '/');
}

// Scan a single JSONL file for fleet registration data
// Returns { fleetId, name } or null
async function scanJsonl(filePath) {
  return new Promise((resolve) => {
    let fleetId = null;
    let name = null;
    let found = false;

    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (found || !line.includes('Registered fleet:')) return;
      try {
        const obj = JSON.parse(line);
        const text = extractText(obj);
        if (!text) return;

        const fleetMatch = text.match(/Registered fleet:([a-f0-9]{8})/);
        if (!fleetMatch) return;

        fleetId = `fleet:${fleetMatch[1]}`;
        const nameMatch = text.match(/Your name: "([^"]+)"/);
        if (nameMatch) name = nameMatch[1];
        found = true;
        rl.close();
      } catch { /* skip malformed lines */ }
    });

    rl.on('close', () => resolve(found ? { fleetId, name } : null));
    rl.on('error', () => resolve(null));
  });
}

// Extract text content from a JSONL message object
function extractText(obj) {
  const msg = obj?.message;
  if (!msg) return null;
  const content = msg?.content;
  if (!content) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const itemContent = item?.content;
      if (typeof itemContent === 'string' && itemContent.includes('Registered fleet:')) {
        return itemContent;
      }
      if (Array.isArray(itemContent)) {
        for (const sub of itemContent) {
          if (sub?.text?.includes('Registered fleet:')) return sub.text;
        }
      }
    }
  }
  return null;
}

async function main() {
  let totalFiles = 0, scanned = 0, upserted = 0, skipped = 0, errors = 0;

  const projectDirs = await readdir(PROJECTS_BASE).catch(() => []);

  for (const dirName of projectDirs) {
    const dirPath = join(PROJECTS_BASE, dirName);
    const cwd = dirToCwd(dirName);

    let files;
    try {
      files = await readdir(dirPath);
    } catch { continue; }

    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    totalFiles += jsonlFiles.length;

    for (const file of jsonlFiles) {
      const filePath = join(dirPath, file);
      const sessionId = basename(file, '.jsonl');
      scanned++;

      // Check if session already in ledger
      const existing = ledger.findBySession(sessionId);
      if (existing) {
        skipped++;
        continue;
      }

      const result = await scanJsonl(filePath).catch(() => null);
      if (!result) continue;

      const { fleetId, name } = result;
      if (!fleetId) continue;

      if (DRY_RUN) {
        console.log(`[dry-run] Would upsert: ${fleetId} (${name || '?'}) session=${sessionId} cwd=${cwd}`);
      } else {
        ledger.upsertAgent(fleetId, sessionId, cwd, name);
      }
      upserted++;
    }
  }

  console.log(`\nBackfill complete${DRY_RUN ? ' (dry run)' : ''}:`);
  console.log(`  Total JSONL files: ${totalFiles}`);
  console.log(`  Scanned: ${scanned}`);
  console.log(`  Already in ledger (skipped): ${skipped}`);
  console.log(`  Upserted: ${upserted}`);
  if (errors) console.log(`  Errors: ${errors}`);
}

main().catch(err => { console.error(err); process.exit(1); });
