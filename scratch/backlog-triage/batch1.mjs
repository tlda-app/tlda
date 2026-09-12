import fs from 'fs';
const D = JSON.parse(fs.readFileSync('dispositions.json','utf8'));
const tasks = JSON.parse(fs.readFileSync('tasks.json','utf8'));
const byTitle = (owner, frag) => {
  const hit = tasks.filter(t=>t.ownerName===owner && t.title.includes(frag));
  if(hit.length!==1) throw new Error(`ambiguous/absent: ${owner} :: ${frag} -> ${hit.length}`);
  return hit[0].id;
};
const set=(owner,frag,mark,ev)=>{ D[byTitle(owner,frag)]=[mark,ev]; };

// --- done: the commit subject IS the deliverable ---
set('history-fold-audit','Fix thread historical names','done','`aedd8f978` on main — "Give thread and search recipients the name they held at send time, and mark amends". ⚠ A later standing note says `thread` still does not fold amends — re-check that half before closing.');
set('claude-ui-clutter-fix','Skip just reported','done','`71c56104a` on main — "Remove recordings chrome from document view".');
set('claude-fleet-reliability','Urgent, live right now','done','`da1d76f0a` "Fix three false-failure/false-negative reliability bugs found tonight" + `217132a11` in-flight spawn guard against concurrent duplicate mints, both on main.');
set('lexical-me-owner','Canonical ownership transfer','done','Title is a transfer note; the work is lexical `me`, landed as `cdada954c` "Fix lexical me in thread cards" on main. Matches the standing ruling in AGENTS.md §"`me` IS LEXICALLY SCOPED".');
set('inbox-empty-diagnosis','Diagnose empty inbox shape','done','`3ab30571d` "Give the inbox its own subscription, like every other panel" + `1f11759f2` "Mark the inbox buffer server-fed, or the subscription delivers into a hole", both on main.');
set('classroom-build-wipe','A failed build must not destroy output','done','`cb1a94beb` on main — "A failed build leaves the last good render serving"; `cff3c21d3` covers the rebuild case.');
set('classroom-positron-heic','HEIC drag-drop and Positron submit proof','done','`147f1e6e8` "A dragged iPhone photo reaches the grader" on main; `9e3cb2a2c` then withdrew the drop provider because the shipped extension already does more.');
set('doc-sync-pm','Reassigning from bhief-of-staff','done','Title is a reassignment note. The work landed: `22fb6182b` "Make LaTeX membership the closure of the document\'s roots" — the implementation AGENTS.md §"A subsystem is Skip\'s decision" names as the correct one.');

// --- live, with evidence that it is NOT finished ---
set('deploy-no-interrupt','Ship the front door','live','Partly landed — `fc7c58cc0`, `51574efd9` "Move the tailnet front door off the machine a deploy replaces". But the newest commit on the theme, `13d093cc0` (08-28), is *"Stage the cutover, and **stop documenting a front door that is not there**"*. By its own author the front door is not shipped.');

// --- superseded: management seats whose current holder is awake ---
for (const [o,f] of [['sync-wedge','Manage tlda app priorities'],['appchief-sol-successor-3','Manage tlda app priorities'],['sol-lead','Manage tlda app priorities']])
  set(o,f,'superseded','`app-chief` holds this (awake, 95 commits on main, most recent today).');
for (const [o,f,who] of [['pm-sync','PM: sync','`reliability-pm`/`sync-repair-sol`'],['pm-audit','PM: the August keep/cut audit','the current chief'],['pm-mint-comms','PM: mint/comms','the current chief']])
  set(o,f,'superseded',`Standing PM seat, owner hibernating 14d; the lane is now run by ${who} under \`tlda-recovery-chief-opus\`.`);

// --- unestablished, but with the lead recorded so the next reader starts there ---
const lead=(o,f,ev)=>set(o,f,'unestablished',ev);
lead('existing-project-link','Fix existing-project link hang','Lead: `2e9ef9e91` on main, "Re-ask for the confirmation, do not rebuild the history that was already sent" — same area, but it does not say the hang is gone.');
lead('project-targets-recovery','Recover projects missing layout targets','Lead: `0ce641013` on main, "Stop loading a document from a manifest entry, which has no targets". Fixes the cause; whether the already-broken projects were recovered is not stated.');
lead('chat-intermittency',"Reproduce Skip's intermittent chat",'Lead: `e7aede620` "Make activity card rendering idempotent". That is a fix, not the reproduction this row asks for.');
lead('versioning-check','Make in-app editing produce a build and a version','Six commits on main incl. `ec37d074e` "Record the root cause: WrongHead, rejected silently" and `94569675b`. Root cause recorded; whether an in-app edit now yields a build **and** a version is not asserted by any of them.');
lead('fleet-db-blocking','Prune the 3.82 GB of FTS nobody sweeps','`29e8474a7` put the vacuum runbook in place, but no commit prunes FTS. Per AGENTS.md `auto_vacuum` is `NONE`, so this needs the maintenance-window procedure run, not code.');
lead('mint-attach','Delegate attaches tasks to the requested name','Owner landed 8 commits on main but none on this subject.');
lead('project-document-ui','Acceptance addition from Skip','Lead: `6719514a2` "Model project document roots by format". Row cites Skip chat#3086828 — read that message before disposing.');
lead('ui-artifact-release','Review pending UI artifacts','Lead: `000573cac` "Restore source editor panel controls". A review row; what it was reviewing is not named in the title.');
lead('app-librarian','Correction/addition from Skip','Row cites Skip chat#3085884 — read that message before disposing.');

fs.writeFileSync('dispositions.json', JSON.stringify(D,null,1));
console.log('dispositions now:', Object.keys(D).length);
