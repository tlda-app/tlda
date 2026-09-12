import fs from 'fs';
// Batch B delegate lines, in the order thread() printed them, with their EDT seconds.
const B = [
 ['21:51:20','Gate late-alpha release preparation'],
 ['21:51:24','Gate stray upload refusal'],
 ['21:51:27','Gate docs and Overleaf onboarding'],
 ['21:51:31','Gate short image references'],
 ['21:51:35','Take this preserved independent layout/obligation gate after…'],
 ['21:51:38','The task’s bounded capture and generic delayed-touch diagnos…'],
 ['21:51:42','The fresh manager handoff was received and executed.'],
 ['21:51:45','Carry accepted WM outputs forward'],
 ['21:51:49','Gate shared highlighter repair'],
 ['21:51:52','Transferred because your hold `2830652`, relayed in wm-follo…'],
 ['21:51:56','Watch post-revert chat telemetry'],
 ['21:51:59','Work with Skip on the tlda README'],
 ['21:52:03','Task expiry notifications and timer path'],
 ['21:52:06','Interleaved two-writer editing session test'],
 ['21:52:10','Restore lifecycle authority and Reanimate'],
 ['21:52:13','Fix invisible math-agent messages'],
 ['21:52:16','Split metadata.source into via and source'],
 ['21:52:20','Build the gesture classifier in the tldraw fork'],
 ['21:52:24','CLI command for an agent to restart its own MCP'],
 ['21:52:27','Stop `tlda daemon stop` from unloading the launchd job'],
 ['21:52:30','Delete wiretaps'],
 ['21:52:34','Build gesture transitions in the tldraw fork'],
 ['21:52:37','Recover and build the index page columns'],
 ['21:52:41','Make composer slider salient on touch'],
 ['21:52:44','Rebuild index page to Skip’s spec'],
];
const to24 = s => { const m=s.match(/(\d+):(\d+):(\d+) (AM|PM)/); let h=+m[1]%12; if(m[4]==='PM') h+=12; return `${String(h).padStart(2,'0')}:${m[2]}:${m[3]}`; };
const lines = fs.readFileSync('page2.txt','utf8').split('\n').filter(l=>l.includes('9307b38c'));
const rows = lines.map(l=>{
  const id = l.match(/^\[([^\]]+)\]/)[1];
  const ts = l.match(/\(([0-9:]+ [AP]M UTC)\)/)[1];
  return {id, t: to24(ts)};
});
const Bmap = Object.fromEntries(B);
const out = {}; let hit=0, miss=[];
for(const r of rows){ if(Bmap[r.t]) { out[r.id]=Bmap[r.t]; hit++; } else miss.push(r); }
console.log('batch B joined 1:1 :', hit, 'of', B.length);
console.log('unjoined nobody rows:', miss.length, miss.map(m=>m.t).join(' '));
fs.writeFileSync('nobody-subjects.json', JSON.stringify(out,null,1));
for(const [k,v] of Object.entries(out)) console.log(' ', k, '=>', v);

// --- second pass: +/-1s tolerance, assert uniqueness ---
const secs = s => { const [h,m,x]=s.split(':').map(Number); return h*3600+m*60+x; };
const out2 = {}; const used=new Set(); let amb=0;
for(const r of rows){
  const cands = B.filter(([t])=>Math.abs(secs(t)-secs(r.t))<=1 && !used.has(t));
  if(cands.length===1){ out2[r.id]=cands[0][1]; used.add(cands[0][0]); }
  else if(cands.length>1){ amb++; console.log('AMBIGUOUS', r.id, r.t, cands.map(c=>c[1])); }
}
console.log('\n=== with +/-1s tolerance: joined', Object.keys(out2).length, 'of', B.length, '| ambiguous:', amb);
const unmatchedB = B.filter(([t,s])=>!used.has(t));
console.log('batch-B subjects still unmatched:', unmatchedB.map(u=>u[1]));
const stillMiss = rows.filter(r=>!out2[r.id]);
console.log('nobody rows not in batch B (= batch A, 08-13):', stillMiss.length);
fs.writeFileSync('nobody-subjects.json', JSON.stringify(out2,null,1));
