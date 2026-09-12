import fs from 'fs';
const D = JSON.parse(fs.readFileSync('dispositions.json','utf8'));
// delegate second (EDT 4:52:xx == UTC 8:52:xx) -> real subject, from
// thread(task_id:"fleet:bc8d-mti8rot0", types:["delegate"]) 09-01 04:52:39-43 EDT
const REAL = {
 '8:52:38':'Verify classroom and extension behavior',
 '8:52:40':'Repair classroom microphone and icon',
 '8:52:41':'Carry this legacy layers record within the classroom lane',
 '8:52:42':'Carry this legacy visual-mode record in the exact-0.2.7 Positron chain',
 '8:52:43':'Carry this legacy Positron integration record in the fresh disposable 0.2.7 chain',
};
const lines = fs.readFileSync('page1.txt','utf8').split('\n').filter(l=>l.includes('Ownership transfer while'));
const NB = JSON.parse(fs.readFileSync('nobody-subjects.json','utf8'));
let n=0;
for(const l of lines){
  const id=l.match(/^\[([^\]]+)\]/)[1];
  const ts=l.match(/\((\d+:\d+:\d+) [AP]M UTC\)/)[1];
  const subj=REAL[ts]; if(!subj) { console.log('unmapped', id, ts); continue; }
  NB[id]=subj;
  D[id]=['live',`**Subject recovered** from the delegate line at 09-01 04:52 EDT — \`classroom-ui-sol\` → \`tlda-recovery-chief-sol\`, whose transfer note overwrote all five titles. All five were held on one measured blocker: **both cache-busted live HW−1 ZIP routes still served the old SHA-256 \`4cb4a219…\`**, with \`shared-code.qmd\` outside the \`.support/\` directory. A corrected ZIP \`d1065039…\` was built at 05:18 and \`pic-release-opus\` was told at 05:20 to publish it to both routes — **so check that landed before re-running any of these.**`];
  n++;
}
fs.writeFileSync('nobody-subjects.json', JSON.stringify(NB,null,1));
fs.writeFileSync('dispositions.json', JSON.stringify(D,null,1));
console.log('recovered + disposed:', n, '| total:', Object.keys(D).length);
