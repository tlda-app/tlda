import fs from 'fs';
const D = JSON.parse(fs.readFileSync('dispositions.json','utf8'));
const T = JSON.parse(fs.readFileSync('tasks.json','utf8'));
const one=f=>{const h=T.filter(t=>t.title.includes(f)); if(h.length!==1) throw new Error(f+' -> '+h.length); return h[0].id;};
const set=(f,m,e)=>{D[one(f)]=[m,e];};

set('Fix mint+delegate dropping the delegation','done','`d1a7b4271` (08-18) on main — "Attach a mint\'s task in the same operation that mints it". Postdates the row and is the deliverable.');
set('Delegate attaches tasks to the requested name','done','Same fix: `d1a7b4271` (08-18) on main attaches the task in the mint operation, so there is no returned-id/requested-name gap left to mis-attach across.');
set('Probe: does delegate refuse a dead seat','superseded','The question was closed from the other side: `203476dda` (08-23) "Close the delegate-notifies-a-live-recipient question with the missing control", and `770f3f375` (08-19) "Never infer death: a failed reanimate leaves a hibernating agent" settles what a dead seat even is. Owner is the one agent in the fleet **marked dead**.');
set('Repair current mint launch failure','done','`f5c044ea2` (08-20) on main, by this owner — "Make mint launch state durable before session discovery"; `39648f5b5` adds "Tell the requester when a mint launches and never answers".');
set('Trace missing expanded-thread collapse','unestablished','Leads `f8da9eb67` (08-12) and `7020b5117` (08-06) are in this exact area but **both predate the row**, so they are prior art, not its resolution. Blocked on `fleet:2b6f-mt2ko64i` (the white-spinner row) and never picked up.');
set('Snap guides match targets','unestablished','`050f97837` (08-21) "Make every fleet snap guide actionable" postdates the row and may close it. Against that, Skip\'s `the-list.md` carries **"The guides do not say which line you will actually snap to"** at ○ — but that list was last written 08-13, *before* the commit, so it cannot settle this either way. Needs one look at the running app.');
set('Get dev running relevant tests against his live surfaces','unestablished','`0271a378e`/`51f477b9f` "Share one bot-heartbeat survey, so a bot\'s death has a witness" are this owner\'s only landed work and are not the deliverable.');
set('Mint probe after the outbox discard','unestablished','Lead: `244732040` (08-20) "Bound daemon outbox receiver debt". The probe this row asks for is not asserted by any commit.');

fs.writeFileSync('dispositions.json', JSON.stringify(D,null,1));
console.log('total dispositions:', Object.keys(D).length);
