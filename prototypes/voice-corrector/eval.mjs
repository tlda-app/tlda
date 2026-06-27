import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalize } from "./normalize.mjs";

const here = dirname(fileURLToPath(import.meta.url));

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonl(path) {
  const raw = await readFile(path, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function surfacePattern(surface) {
  const tokenBoundary = String.raw`[\p{L}\p{N}_]`;
  const escaped = surface
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(String.raw`\s+`);
  return new RegExp(String.raw`(?<!${tokenBoundary})${escaped}(?!${tokenBoundary})`, "iu");
}

function pct(passed, total) {
  if (total === 0) return "n/a";
  return `${((passed / total) * 100).toFixed(1)}%`;
}

function printTable(rows) {
  const headers = ["class", "n", "passed", "accuracy", "notes"];
  const widths = headers.map((header) => header.length);

  for (const row of rows) {
    const values = [row.class, String(row.n), String(row.passed), row.accuracy, row.notes ?? ""];
    values.forEach((value, i) => {
      widths[i] = Math.max(widths[i], value.length);
    });
  }

  const format = (values) => values.map((value, i) => value.padEnd(widths[i])).join("  ");
  console.log(format(headers));
  console.log(format(widths.map((width) => "-".repeat(width))));
  for (const row of rows) {
    console.log(format([row.class, String(row.n), String(row.passed), row.accuracy, row.notes ?? ""]));
  }
}

const [vocab, dataset] = await Promise.all([
  readJson(join(here, "vocab.json")),
  readJsonl(join(here, "dataset.jsonl"))
]);

const scored = new Map();
const falseRewrites = [];
const contextFreeFailures = [];

for (const item of dataset) {
  const result = normalize(item.msg_excerpt, vocab);
  const changed = result.corrected !== item.msg_excerpt;

  if (item.class === "context-free-garble") {
    const fixedSurface = !surfacePattern(item.surface).test(result.corrected);
    const hasCorrect = surfacePattern(item.correct).test(result.corrected);
    const pass = changed && fixedSurface && hasCorrect;
    const bucket = scored.get(item.class) ?? { class: item.class, n: 0, passed: 0 };
    bucket.n += 1;
    bucket.passed += pass ? 1 : 0;
    scored.set(item.class, bucket);
    if (!pass) {
      contextFreeFailures.push({ item, result });
    }
    continue;
  }

  if (item.class === "context-dependent") {
    const pass = !changed;
    const bucket = scored.get(item.class) ?? { class: item.class, n: 0, passed: 0 };
    bucket.n += 1;
    bucket.passed += pass ? 1 : 0;
    scored.set(item.class, bucket);
    if (!pass) {
      falseRewrites.push({ item, result });
    }
    continue;
  }

  if (changed) {
    falseRewrites.push({ item, result });
  }
  const bucket = scored.get(item.class) ?? { class: item.class, n: 0, passed: 0 };
  bucket.n += 1;
  scored.set(item.class, bucket);
}

const rows = [...scored.values()].map((row) => ({
  ...row,
  accuracy: row.class === "correction-event" || row.class === "candidate-garble" ? "unscored" : pct(row.passed, row.n),
  notes: row.class === "context-dependent" ? "abstained unchanged" : row.class === "correction-event" || row.class === "candidate-garble" ? "reported only" : ""
}));

console.log("Phase 1 context-free vocabulary normalizer eval");
console.log("");
printTable(rows);
console.log("");
console.log(`False rewrites: ${falseRewrites.length}`);

if (contextFreeFailures.length > 0) {
  console.log("");
  console.log("Context-free failures:");
  for (const { item, result } of contextFreeFailures) {
    console.log(`- id ${item.id}: ${JSON.stringify(item.msg_excerpt)} -> ${JSON.stringify(result.corrected)}`);
  }
}

if (falseRewrites.length > 0) {
  console.log("");
  console.log("False rewrites:");
  for (const { item, result } of falseRewrites) {
    console.log(`- id ${item.id} (${item.class}): ${JSON.stringify(item.msg_excerpt)} -> ${JSON.stringify(result.corrected)}`);
  }
}

const contextFree = scored.get("context-free-garble");
if (falseRewrites.length > 0 || !contextFree || contextFree.passed !== contextFree.n) {
  process.exitCode = 1;
}
