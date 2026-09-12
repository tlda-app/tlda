import fs from 'fs';
const AWAKE = new Set(`wm-frame-adapter static-deck-toolset backlog-triage two-day-writing-openai two-day-staffing-openai quiet-todd tlda-recovery-chief-sol staff-fuckups sync-repair-sol sol-dev quiet-teacher tlda-recovery-chief-advocate-4 tlda-recovery-chief-opus slides-requirements-reader slides-content-advocate quiet-dev lab1-deck-tester pic-release-opus lab1-floor-builder intro-polish-process-advocate hw-release-pairing pic-lecture-advocate pic-lab1 experiment-plot-design intro-polish quiet-grammar classroom-ui-sol browser-perf classroom-repair-sol quiet-nobody classroom-delivery-advocate-sol chief-advocate-fresh classroom-pm-2 ahat-lint bhief-of-getting-shit-done app-historian app-chief bhief-4`.split(/\s+/));
const tasks = JSON.parse(fs.readFileSync('tasks.json','utf8'));
const D = JSON.parse(fs.readFileSync('dispositions-base.json','utf8'));   // hand-written only
// STRICT: the row IS a seat/advocacy assignment, not work that mentions an advocate.
const SEAT = [
  /^Advocate(\s|:|$)/i, /^Fresh advocate\b/i, /^Standing advocate\b/i,
  /^Take the chief of staff seat/i, /^Watch chief work\b/i,
  /^You are the independent .* advocate/i, /^Independent check on the chief/i,
  /^Advocate-review\b/i, /^Stood down from this seat/i,
];
const isSeat = t => SEAT.some(r=>r.test(t));
let sup=0, live=0, skipped=[];
for(const t of tasks){
  if(D[t.id]) continue;
  if(!isSeat(t.title)) continue;
  if(AWAKE.has(t.ownerName)) { D[t.id]=['live',`Owner \`${t.ownerName}\` is awake and holds this advocacy now.`]; live++; }
  else { D[t.id]=['superseded',`Advocacy seat for work that has moved on; owner \`${t.ownerName}\` hibernating ${Math.round(t.ageMin/1440)}d. Current advocacy is \`tlda-recovery-chief-advocate-4\` / \`chief-advocate-fresh\`, both awake.`]; sup++; }
}
fs.writeFileSync('dispositions.json', JSON.stringify(D,null,1));
console.log('strict seat rows -> live:', live, 'superseded:', sup, '| total dispositions:', Object.keys(D).length);
console.log('\nrows my LOOSE regex would have wrongly swept (now left unestablished):');
const LOOSE=/advocate|chief of staff seat|take the .*seat|watch chief|watching chief|independent check on the chief|stood down/i;
for(const t of tasks) if(!D[t.id] && LOOSE.test(t.title)) console.log('  -', t.ownerName, '::', t.title.slice(0,72));
