import fs from 'fs';
const D = JSON.parse(fs.readFileSync('dispositions.json','utf8'));
const tasks = JSON.parse(fs.readFileSync('tasks.json','utf8'));
const EV = 'Superseded by the current introduction lane: `intro-polish` (awake) with `intro-polish-process-advocate` (awake), which reported 09-01 04:52 that it holds the artifact under an active gate. That lane, not this 9-day-old cohort, is where the work is.';
const COHORT = ['intro-writer-fresh','intro-reconciler','intro-integrator','intro-register-critic','intro-sentence-writer','term-sentence-writer','synth-paper','writing','intro-outline-advocate','synth-newintro-advocate','appendix-math'];
let n=0;
for(const t of tasks){
  if(D[t.id]) continue;
  if(COHORT.includes(t.ownerName)){ D[t.id]=['superseded',EV]; n++; }
}
// the two live holders
for(const t of tasks){
  if(t.ownerName==='intro-polish') D[t.id]=['live','Held now. `intro-polish-process-advocate` reports the artifact under an active gate, writer frozen, nothing accepted.'];
  if(t.ownerName==='intro-polish-process-advocate') D[t.id]=['live','**Deliberately blocked on one bare question to Skip** — the referent of "second bullet" in his own instruction. Three agents have guessed; the advocate is holding rather than mutating. Subscription #92757 live. This is the one row in this bucket that genuinely needs him.'];
}
fs.writeFileSync('dispositions.json', JSON.stringify(D,null,1));
console.log('intro cohort superseded:', n, '| total:', Object.keys(D).length);
