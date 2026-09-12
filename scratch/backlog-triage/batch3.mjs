import fs from 'fs';
const D = JSON.parse(fs.readFileSync('dispositions.json','utf8'));
const tasks = JSON.parse(fs.readFileSync('tasks.json','utf8'));
const NBmap = JSON.parse(fs.readFileSync('nobody-subjects.json','utf8'));
const one=(frag)=>{let h=tasks.filter(t=>t.title.includes(frag));
 if(h.length!==1){ const ids=Object.entries(NBmap).filter(([,v])=>v.includes(frag)).map(([k])=>k); if(ids.length===1) return ids[0]; throw new Error(`${frag} -> ${h.length}/${ids.length}`);} return h[0].id;};
const set=(frag,m,e)=>{D[one(frag)]=[m,e];};

// --- rows whose own text records the outcome ---
set('WITHDRAWN BY SKIP','superseded','The row\'s own text: **withdrawn by Skip, 2026-08-18 ~01:25 EDT.**');
set('The owner-only bootstrap action is already satisfied','done','The row\'s own text says the owner-only action is already satisfied.');
set('Integrated PIC-dev stage is complete and production is uncha','done','The row\'s own text: the integrated stage is complete and production unchanged.');
set('Primitive-condition repair is complete and reported in messa','done','The row\'s own text: repair complete and reported. The cited message is the evidence to check if closing.');
set('The fresh manager handoff was received and executed.','done','The row\'s own text: handoff received and executed. (Recovered subject — this row is one of the 34 whose title `tasks()` hides.)');
set('Drop-test complete; no task work was performed.','done','The row\'s own text: drop-test complete, no task work performed. Skip-owned, so closing it is his.');
set('Task remains intentionally unstarted under your chat#3067914','live','**Intentionally unstarted** under Skip\'s chat#3067914 — a deliberate hold, not neglect. Read that message before anyone restarts it.');
set('Parked: garbage in the B.3 setting','live','Explicitly **parked**, not abandoned. Owner hibernating 14d; parking was a decision, resuming is one too.');
set("Parked: B.2's a.e. handling, deal properly",'live','Explicitly **parked**, not abandoned. Owner hibernating 14d.');

// --- the 33 remaining parked-under-nobody rows ---
const NB = JSON.parse(fs.readFileSync('nobody-subjects.json','utf8'));
let nb=0;
for(const t of tasks){
  if(D[t.id]) continue;
  if(t.ownerName!=='nobody') continue;
  const real = NB[t.id];
  if(real) D[t.id]=['unestablished',`Parked by \`claude-chief\` 08-16 17:51 for "owner hibernating, no live progress" — a fact about the owner, not about the work. **No commit on main carries this subject.** Whether Skip still wants it is his call or the chief's, not an agent's.`];
  else D[t.id]=['unestablished',`Moved to \`nobody\` by \`fall-class\` 08-13 15:22 **"at Skip's request"** — that citation is unchecked. Title is the transfer note; the real subject is one of the nine in the batch-A list, which resolve only to the second, not to the row.`];
  nb++;
}
fs.writeFileSync('dispositions.json', JSON.stringify(D,null,1));
console.log('parked rows annotated:', nb, '| total dispositions:', Object.keys(D).length);
