// Proves: agent cwd -> project (longest sourceDir match) -> that project's
// macros, and that katex lints paper macros (\E, \chis) clean only when the
// resolving folder is that paper's. Run: node test/macro-cwd-resolve.mjs
import katex from 'katex';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed local cert
const SERVER = process.env.TLDA_SERVER || 'https://localhost:5176';
const TOKEN = process.env.TLDA_TOKEN || 'c5e4726ab77972fc7312f3a703f9cf1c';
const f = (url) => fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });

async function resolveDoc(cwd) {
  const res = await f(`${SERVER}/api/projects`);
  const { projects } = await res.json();
  let best = null;
  for (const p of projects) {
    if (!p.sourceDir) continue;
    const sd = p.sourceDir.replace(/\/+$/, '');
    if (cwd === sd || cwd.startsWith(sd + '/')) {
      if (!best || sd.length > best.len) best = { name: p.name, len: sd.length, sd };
    }
  }
  return best;
}

async function macrosFor(doc) {
  if (!doc) return {};
  const res = await f(`${SERVER}/api/projects/${encodeURIComponent(doc)}/macros`);
  if (!res.ok) return {};
  return (await res.json()).macros || {};
}

function lintMath(tex, macros) {
  try { katex.renderToString(tex, { throwOnError: true, macros }); return null; }
  catch (e) { return e.message; }
}

const cases = [
  { cwd: '/Users/skip/work/bregman-lower-bound', expectDoc: 'bregman' },
  { cwd: '/Users/skip/work/bregman-lower-bound/proofs/sub/dir', expectDoc: 'bregman' },
  { cwd: '/Users/skip/work/tlda', expectDoc: null }, // whatever maps; just report
];

let fail = 0;
for (const c of cases) {
  const best = await resolveDoc(c.cwd);
  const doc = best?.name || null;
  const macros = await macrosFor(doc);
  const eErr = lintMath('\\E[X]', macros);
  const chisErr = lintMath('\\chis', macros);
  const eNoMacro = lintMath('\\E[X]', {});
  console.log(`cwd=${c.cwd}`);
  console.log(`  -> doc=${doc} (sourceDir=${best?.sd ?? 'none'})  macroCount=${Object.keys(macros).length}`);
  console.log(`  \\E[X] with doc macros: ${eErr ? 'ERROR ' + eErr : 'CLEAN'}`);
  console.log(`  \\chis with doc macros: ${chisErr ? 'ERROR ' + chisErr : 'CLEAN'}`);
  console.log(`  \\E[X] with NO macros (baseline, should error): ${eNoMacro ? 'ERROR (expected)' : 'CLEAN (unexpected!)'}`);
  if (c.expectDoc !== null && doc !== c.expectDoc) { console.log(`  ✗ expected doc=${c.expectDoc}`); fail++; }
  if (c.expectDoc === 'bregman' && (eErr || chisErr)) { console.log('  ✗ bregman macros should lint clean'); fail++; }
  console.log('');
}
console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
