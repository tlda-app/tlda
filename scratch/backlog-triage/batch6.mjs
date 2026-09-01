import fs from 'fs';
const D = JSON.parse(fs.readFileSync('dispositions.json','utf8'));
const T = JSON.parse(fs.readFileSync('tasks.json','utf8'));
const one=f=>{const h=T.filter(t=>t.title.includes(f)); if(h.length!==1) throw new Error(f+' -> '+h.length); return h[0].id;};
const set=(f,m,e)=>{D[one(f)]=[m,e];};
const LANE='Rolled into tonight\'s classroom recovery — `classroom-pm-2`, `classroom-repair-sol`, `classroom-ui-sol`, `hw-release-pairing`, `pic-release-opus`, all awake under the chief. Still wanted; the owner on this row is not the one doing it.';

set('Deliver working Homework -1 and 0','live','**Still open tonight.** The chief reports `classroom-pm-2` established HW−1 and HW0 **reach zero students** — never in `documentRoots` — and that `week0-homework.qmd` is published while its source no longer exists in the repo. `7989cb60f`/`6864b4180` (09-01) fix visual-mode rendering, which is a different half.');
set('Fix HW−1 and HW0 writing','live',LANE+' Same subject as the row above, which the chief has live.');
set('Add Positron visual-mode CSS to handouts','done','`6864b4180` "Recognize homework in Quarto visual mode" and `7989cb60f` "Package visual-mode homework fix as 0.2.8", both on main today (09-01), both postdating this row.');
set('Make book build and view on pic','live','`85326627a` (08-25) is a resumption point naming the cause: **pic has no daemon, which is why the course book never built.** A diagnosis, not a fix — the row stands and is blocked on that.');
set('Build classroom layer system','superseded','Overtaken by the layer work that landed: `430195d67` "Merge classroom student layers" (08-27) and `c9978e0f9` "Compose classroom layers for the instructor" (08-31).');
set('Complete classroom token access','live',LANE+' Leads `b669537cc` "Gate pic-dev with classroom tokens" and `6404d0106` "Ask who the reader is by credential, not by query parameter" (both 08-27/28) move it but do not assert it complete.');
set('Deliver working public classroom flow','live',LANE+' No commit on main carries this subject.');
set('Establish correct Quarto release process','live',LANE+' No commit on main carries this subject; the chief has the release process live tonight.');
set('Reconcile syllabus topic schedule','live',LANE+' No commit on main carries this subject.');
set('Fix HTML/ZIP divergence in course release','live','Owner `hw-release-pairing` is **awake**. Leads `78ca0ae63` "Retry interrupted course release stages" (08-30) and `d0b8098c9` (08-31) are adjacent, neither asserts the divergence fixed.');
set('Recover this existing classroom PM session and carry the att','superseded','Session recovery for `classroom-pm`, hibernating 7d. `classroom-pm-2` is awake and carrying the lane.');
set('Independently verify classroom recovery','superseded','`classroom-advocate` landed its record — `d153376a9` "The advocate\'s record of the classroom recovery", `f032ff8fd`, `bb22c804b`, `fd0a28a63`, `5ef53e13a` (all 08-28). Verification of *that* recovery is filed; tonight\'s is a later one with its own advocates awake.');
set('Retry retained document failures each sweep','superseded','The premise was retracted: `e7685664d` (09-01) **"CORRECTION: the detached SVG is collectable, not retained"**, reversing `bc1e20951`. There is no retained-document failure to retry.');

fs.writeFileSync('dispositions.json', JSON.stringify(D,null,1));
console.log('total dispositions:', Object.keys(D).length);
