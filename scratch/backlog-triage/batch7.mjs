import fs from 'fs';
const D = JSON.parse(fs.readFileSync('dispositions.json','utf8'));
const T = JSON.parse(fs.readFileSync('tasks.json','utf8'));
const one=f=>{const h=T.filter(t=>t.title.includes(f)); if(h.length!==1) throw new Error(f+' -> '+h.length); return h[0].id;};
const set=(f,m,e)=>{D[one(f)]=[m,e];};

// --- time-critical ---
set('Deck/chapter read: Sep 3 and Sep 8/10','live','**Dated, and the first date is in 48 hours.** Raised 7d ago, owner `deck-read-mid` hibernating since. Nobody is reading these.');
set('Deck/chapter read: Sep 15 and Sep 17','live','**Dated.** Raised 7d ago, owner `deck-read-late-2` hibernating since.');

// --- seats / checkpoints superseded by the current chief ---
set('Chief-of-staff live coordination checkpoint','superseded','A chief-of-staff checkpoint whose owner is hibernating with the task still marked `working`, stale 371h. The seat is held by `tlda-recovery-chief-opus`.');
set("**This is the seat's recurring obligation and the seat is yo",'superseded','A seat\'s recurring obligation; `chief-aug18` hibernating 15d. The obligation travels with the seat, which the current chief holds.');

// --- handback notes: the title is the note, not the work ---
for (const f of ['# handback','Transferring per your ruling — nothing on this list is mine','Taking this back off my queue — the next action is yours, so','**Transferring because the next action is yours.','Corrected candidate returned — transferring, since by your o','Recovered canonical record and created `/Users/skip/worktree','Take ownership and implement the task as assigned by the cur','Candidate ready for integrated current-main and advocate rev','**This task is Skip\'s and it is now yours.','Citation correction: final scope authority is chat#3071535 a','Skip finalized the conflict workflow in messages 3028492–302','Add Skip message 3028421 as a required convergence-harness u','**Item 8, final piece of the design, from Skip.','Correction superseding the deck-as-peer phrasing: Skip says','Update before you start: Skip added detail and pointed you a','Next action is your independent PASS/BLOCK on exact held com','This older classroom audit/repair task is now in assembly an'])
  set(f,'unestablished','**The title is a handoff/correction note, not the task.** What it transfers is only in the referenced thread or message id. Establishing it means reading that reference — the same defect as the 39 rows in §3, one at a time rather than in bulk.');

// --- the math cohort ---
const MATH=['fixed-count-prefix-sol','fixed-count-review-sol','asymptotic-rate-sol','queue-paper-reader-sol','perm-transfer','e2-specialist','idio-sweep','interviewer-b','interviewer-c','synth-audit'];
let m=0;
for(const t of T){ if(D[t.id]||!MATH.includes(t.ownerName)) continue;
  D[t.id]=['unestablished','Part of a mathematics cohort that all hibernated on 08-19/08-20. **Not establishable from this repository** — the work lives in paper checkouts, not in tlda, so no commit here can settle it. Needs `math-historian` or a read of these threads.']; m++; }

D[T.find(t=>t.ownerName==='bregman-architect').id]=['unestablished','The defect *class* has landed fixes on main — `a9074bc8e` "Scope external-sync deletions to what the remote itself introduced" and `f08b95238` "Resolve a closure member that points through a committed symlink". **Whether this row is closed is a statement about one of his own documents, which is not mine to make or to check.** Him or the chief.'];

fs.writeFileSync('dispositions.json', JSON.stringify(D,null,1));
console.log('math cohort:', m, '| total dispositions:', Object.keys(D).length);
