import fs from 'fs';
const D = JSON.parse(fs.readFileSync('dispositions.json','utf8'));
const tasks = JSON.parse(fs.readFileSync('tasks.json','utf8'));
const AWAKE = new Set(`wm-frame-adapter static-deck-toolset backlog-triage two-day-writing-openai two-day-staffing-openai quiet-todd tlda-recovery-chief-sol staff-fuckups sync-repair-sol sol-dev quiet-teacher tlda-recovery-chief-advocate-4 tlda-recovery-chief-opus slides-requirements-reader slides-content-advocate quiet-dev lab1-deck-tester pic-release-opus lab1-floor-builder intro-polish-process-advocate hw-release-pairing pic-lecture-advocate pic-lab1 experiment-plot-design intro-polish quiet-grammar classroom-ui-sol browser-perf classroom-repair-sol quiet-nobody classroom-delivery-advocate-sol chief-advocate-fresh classroom-pm-2 ahat-lint bhief-of-getting-shit-done app-historian app-chief bhief-4`.split(/\s+/));
let live=0, stale=[];
for(const t of tasks){
  if(D[t.id]) continue;
  if(!AWAKE.has(t.ownerName)) continue;
  if(t.ageMin!=null && t.ageMin < 1440){ D[t.id]=['live',`Owner \`${t.ownerName}\` is awake and this was notified ${t.ageMin<120?t.ageMin+'m':Math.round(t.ageMin/60)+'h'} ago — in hand now.`]; live++; }
  else stale.push(t);
}
fs.writeFileSync('dispositions.json', JSON.stringify(D,null,1));
console.log('awake+recent -> live:', live, '| total:', Object.keys(D).length);
console.log('\nAWAKE owner but task is STALE (>24h) — these are the interesting ones:');
for(const t of stale) console.log(`  ${Math.round(t.ageMin/1440)}d [${t.ownerName}] ${t.title.slice(0,66)}`);
