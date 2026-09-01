import fs from 'fs';
const D = JSON.parse(fs.readFileSync('dispositions.json','utf8'));
const T = JSON.parse(fs.readFileSync('tasks.json','utf8'));
const one=f=>{const h=T.filter(t=>t.title.includes(f)&&!D[t.id]); if(h.length<1) throw new Error(f); return h[0].id;};
const set=(f,m,e)=>{D[one(f)]=[m,e];};
const OWN=(f,e)=>set(f,'superseded',e);

set("Make main's daemon suite come back clean",'done','Owner `daemon-suite-red` is awake and landed the run on 08-31: `e5cdf8d4e` "Retire daemon tests asserting three replaced contracts", `cf5aa7e32`, `69b467bb0`, `8d634aae4`, `c4a9084fa` — five commits on main clearing stale assertions.');
set('Fix TLS preview source push','done','`e5701db4e` (08-26) on main — "The server\'s self-remote uses the host its cert is issued for"; `29389baf2` records the `TLDA_SELF_BASE_URL` trap alongside it.');
set('Verify the resolved model default','done','`4fac22085` (08-17) records the resolved model on a seat, `8687158d6` backfills the agents minted before it. The probe this row asks for is satisfied by the backfill existing.');
set('Implement settled Overleaf daemon sync','done','`e3ba10559` "Make Git remotes ordinary daemon sources", `6d524dea7`, `84b9733f2`, `3d7565539` — this owner\'s four commits on main (08-20). `8b4eac118` (08-24) then records **"Overleaf settled as fine"**.');
set('Witness deployed search card interaction','superseded','`b5011fca1` (08-27) "Record the search integration disposition" is this owner\'s own filing. The card itself changed under it — expand deleted `3d4454abe`, one control landed `6a4c8acf4` — so what this row was to witness no longer exists in that form.');
set('Remaining work only: verify search-card-one-control on its o','live','`6a4c8acf4` and `196dd5929` landed on main, so the change is shipped and **unverified on the surface**. `search-pm` established the obstacle: a card with a second page of results may be unreachable on a preview by construction — `--sandbox` gives a daemon but no real history, `--real-fleet` the reverse. That obstacle is the thing to settle, not the button.');
set('Own whether the app works for Skip day to day','superseded','A standing ownership seat, owner hibernating 9d. That job is the chief\'s now, and `reliability-pm`\'s 183 commits on main stop at 08-29.');
set('Own recovery for already-diverged sync rooms','unestablished','Lead: `304b054b7` (08-29) "Apply the accepted head when doing so cannot cost anything". `a1c0d768c` is a warning against this row\'s own method — *"Record two instruments agreeing on an absence because they share a blind spot."*');
set('Own paper-text integrity and the viewing bugs','unestablished','This owner\'s `7cdc0cb90` "Make this file\'s shape cleanups able to delete, which they never could" was **reverted today** by `7b2d716cc`. Whichever way that row goes, it is not closed.');
set('Branch, diverge, merge back without junk commits','unestablished','Leads `4f588b0e6` (08-28) "Record the equal-tree silent success as the probe boundary" and this owner\'s nine commits on main to 08-22. None asserts the junk-commit-free round trip.');
set('Make cleanup bots reliable','live','Blocked on `fleet:0f10-mt1swqpo`. Nothing on main carries it, and it is the same subject as Skip\'s own `the-list.md` row **"Bots that aren\'t all fucked up"** — *"that\'s a fucking item, right"*, his words.');
set('Fix the missing read-file route','unestablished','Lead: `cd2119ce0` (08-23) "Record that the markdown gate is shared and one branch of it is dead" — adjacent, and it *records* a dead branch rather than restoring a route.');
set('Diagnose mint success-without-login and dropped delegation','done','Both halves landed: `4c10d8438` (08-23) "Give login the transport identity it just resolved" and `d1a7b4271` (08-18) "Attach a mint\'s task in the same operation that mints it".');
set('Audit history table folds','unestablished','Lead: `b5e6ce08a` "Document the identity and labeling system" — but that is 07-31, **two weeks before this row**, so it is the thing being audited, not the audit.');
set('Integrate approved freshness resilience manifest','unestablished','**The oldest open row in the fleet at 41 days**, blocked on `fleet:d8fa-mrwq97vb`, owner `pin` hibernating. Nothing on main carries the subject.');
set('Replace lecture agent with Opus','superseded','A staffing action. `pic-lecture-advocate` and the Lab 1 cohort are awake on opus and ran today\'s lecture day.');
set('Serve as Codex app tester','superseded','A standing seat for a Codex tester, hibernating 13d. `app-tester` and `tlda-dev pw` cover this, and the chief issued a standing rule on the pooled browser tonight.');
set("Mark old-sync entries with Skip's dispositions",'unestablished','Lead: `b48d98be0` (08-22) "Recover the sixteen sync promises as a specification" — the specification exists; whether his dispositions were marked against it is not asserted.');
set('Audit slice S6: Aug 13 commits','unestablished','One slice of the August keep/cut audit. `c1e83aa62` preserved that audit\'s output before scratch/ was swept; whether S6 was ever run is not established.');
set('Audit the two-week window under the last two chiefs','unestablished','Same audit family. The window it names is now three weeks past and two further chiefs have held the seat.');
set('New sync deploy 2: post-accept effects + daemon caller','unestablished','Lead: `8df7d86bc` (08-18) "Give the accept path the effects it owed, so an accept preserves the work" — this owner\'s own commit and plausibly the deliverable, but it does not name the daemon caller half.');
set('Independent root-cause report on document sync','unestablished','No commit carries this subject. The nearest artifacts are `9a66b204`\'s own; the sync root-cause work that did land came from other owners.');
set('Why supervised dev is not reclaiming','live','Skip\'s own `the-list.md` carries this at ○ — **"An inert `dev` reclaims no disk"**. Not currently biting: 75 GB free, load 17.6, measured tonight. But `dev` runs as `quiet-dev`, and per `96c35417d` that prefix has two causes and only one of them is a decision.');
set('Trace 30-second project white spinner','unestablished','Lead: `b6161bc45` (08-18) "Show the last good render while a rebuild runs" — masks the wait rather than explaining 30 seconds. `94ade5eed` warns in the same area about a monitor flagging designed behaviour as a fault.');
set('Decide: 13GB unreproducible, remaining conditions need your ca','live','**A decision row sitting with `sol-dev`, who is awake and on-call, for 6 days.** By its own title the next action is a call somebody has to make.');
set('Prove sync works and does not corrupt projects','unestablished','No commit asserts this proof. `21a4e891` landed nothing on main.');

for(let i=0;i<3;i++) set('Ownership transfer while the chief/package lane has the next','unestablished','One of **five** rows on `tlda-recovery-chief-sol` sharing this transfer note as their title — the §3 defect on a live agent. The owner is **awake**; one question to them recovers all five subjects.');

fs.writeFileSync('dispositions.json', JSON.stringify(D,null,1));
console.log('total dispositions:', Object.keys(D).length);
