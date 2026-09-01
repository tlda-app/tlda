import fs from 'fs';
const agentsLine = fs.readFileSync('page1.txt','utf8').split('\n')[0];
const names = {};
for (const m of agentsLine.matchAll(/"([^"]+)"\s*\[(fleet:[0-9a-z]+)\]/g)) names[m[2]] = m[1];
// page2 agents line, added manually
const p2agents = `"chief-3" [fleet:0cc5bdf1], "app-chief6" [fleet:13f93587], "sync-wedge" [fleet:2d2c7136], "codex-rendering" [fleet:2ddd5805], "crisis-manager" [fleet:343b24cf], "app-fix-forward" [fleet:38c409a7], "wm-followthrough-manager" [fleet:58d0a757], "wm-crash-delivery" [fleet:6ba2edc0], "bhief-successor" [fleet:752fd04a], "nobody" [fleet:9307b38c], "chief-of-staff-opus" [fleet:989450f0], "cchief" [fleet:9ef0239d], "snmm-recovery" [fleet:bef70ada], "little-ui" [fleet:c1422b33], "docs-release-manager" [fleet:c90e8115], "fall-class" [fleet:ce8b5239], "recon-lead" [fleet:e355d887], "bhief-successor:Avicenna" [fleet:e3b594c0], "chiefsoso" [fleet:ead4c7c2], "skip" [fleet:skip], "opus-chief-successor" [fleet:b0ceefca], "pin" [fleet:d8fa8779], "chiefdoc-successor" [fleet:e2d321dc]`;
for (const m of p2agents.matchAll(/"([^"]+)"\s*\[(fleet:[0-9a-z]+)\]/g)) if(!names[m[2]]) names[m[2]] = m[1];

const rows = [];
for (const file of ['page1.txt','page2.txt']) {
  const text = fs.readFileSync(file,'utf8');
  // join continuation lines: a row starts with [
  const raw = text.split('\n');
  let buf = null;
  for (const ln of raw) {
    if (/^\[(fleet|native):/.test(ln)) { if (buf) rows.push(buf); buf = ln; }
    else if (buf !== null) { if (/\|\s*\d+m ago/.test(ln) || ln.trim()) buf += ' ' + ln.trim(); }
  }
  if (buf) rows.push(buf);
}
const out = [];
for (const r of rows) {
  const m = r.match(/^\[([^\]]+)\]\s+(fleet:[0-9a-z]+)\s*\|(.*)$/);
  if (!m) { console.error('NOMATCH', r.slice(0,80)); continue; }
  const [_, id, owner, rest] = m;
  const parts = rest.split(' | ').map(s=>s.trim());
  // find index of the age field  (/^\d+m ago$/)
  let ai = parts.findIndex(p=>/^\d+m ago$/.test(p));
  let title, age;
  if (ai > 0) { title = parts[ai-1]; age = parseInt(parts[ai]); }
  else { title = parts[parts.length-1]; age = null; }
  const state = parts[0];
  out.push({id, owner, ownerName: names[owner]||'?', state, ageMin: age, title});
}
// dedupe by id
const seen = new Set(); const uniq = out.filter(o=>!seen.has(o.id)&&seen.add(o.id));
fs.writeFileSync('tasks.json', JSON.stringify(uniq,null,1));
console.log('rows parsed:', uniq.length);
const byOwner = {};
for (const t of uniq) (byOwner[t.ownerName] ||= []).push(t);
console.log('distinct owners:', Object.keys(byOwner).length);
console.log('skip-owned:', uniq.filter(t=>t.owner==='fleet:skip').length);
console.log('nobody-owned:', uniq.filter(t=>t.ownerName==='nobody').length);
