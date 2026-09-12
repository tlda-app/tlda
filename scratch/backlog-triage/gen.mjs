import fs from 'fs';
const tasks = JSON.parse(fs.readFileSync('tasks.json','utf8'));

// disposition map: id -> [mark, evidence]
const D = JSON.parse(fs.readFileSync('dispositions.json','utf8'));
const NOBODY = JSON.parse(fs.readFileSync('nobody-subjects.json','utf8'));
for(const t of tasks) if(NOBODY[t.id]) { t.realTitle = NOBODY[t.id]; }

const TOPICS = [
 ['Assigned to Skip', t=>t.owner==='fleet:skip'],
 ['Parked under `nobody` — 34 rows nobody has triaged', t=>t.ownerName==='nobody'],
 ['Lab 1 and this week’s lecture', t=>/deck|slide|lab 1|lecture|experiment plot|coordinate frame|Sampling chapter/i.test(t.title)||['static-deck-toolset','wm-frame-adapter','slides-requirements-reader','experiment-plot-design','pic-lab1','lab1-floor-builder','lab1-deck-tester','slides-content-advocate','deck-read-mid','deck-read-late-2','classroom-quarto-pm'].includes(t.ownerName)],
 ['Classroom — homework, release, students', t=>/classroom|homework|hw|quarto|syllabus|positron|student|course|book|token|LMS/i.test(t.title)||/classroom|qtm285|pic-|hw|homework|fall-class/i.test(t.ownerName)],
 ['Sync and source of truth', t=>/sync|source push|symlink|overleaf|convergence|reference link|diverged/i.test(t.title)||/sync|overleaf|doc-sync|strip-old-sync/i.test(t.ownerName)],
 ['The app Skip uses day to day', t=>/highlight|search|inbox|chip|scroll|thread|panel|snap|spinner|diff|chat|annotation|layout|model in the agents|白/i.test(t.title)||['app-tester','search-pm','search-card-expand','chip-drag','snap-grid-visualization','whole-document-diff-ui','panel-model-row','claude-scroll-drift-fix','claude-scroll-bottom-fix','claude-ui-clutter-fix','project-targets-recovery','inbox-empty-diagnosis','little-ui','ui-artifact-release','project-document-ui','pdf-document-architecture'].includes(t.ownerName)],
 ['Infrastructure — daemon, mint, storage, tests', t=>/daemon|mint|build|disk|FTS|deploy|route|launch|cleanup bot|test|queue|reclaim|login|delegate|read-file/i.test(t.title)||/mint|daemon|dev-noticer|fleet-db|deploy|drain-probe|mini-disk|queue|login-broken|versioning/i.test(t.ownerName)],
 ['Writing and papers', t=>/intro|outline|proof|appendix|paper|sentence|transcript|term|register|merge|Gram|small-ball|multiplier|diagonal|optimizer|vanishing|randomization|B\.2|B\.3|duality|estimator/i.test(t.title)||/intro|paper|synth|appendix|proof|writer|interviewer|e2-|fixed-count|asymptotic|duality|queue-paper|idio|perm-transfer|eiv|rynth|writing/i.test(t.ownerName)],
 ['Fleet process, ownership, audits', t=>true],
];

function topicOf(t){ for(const [n,f] of TOPICS) if(f(t)) return n; return 'Unclassified'; }
const groups = {};
for(const t of tasks) (groups[topicOf(t)] ||= []).push(t);

const age = m => m==null?'?':(m<120?`${m}m`:m<1440?`${Math.round(m/60)}h`:`${Math.round(m/1440)}d`);
const MARK = {live:'**live**',done:'done, unclosed',superseded:'superseded',unestablished:'unestablished'};

let out = `# Open tasks by topic — rebuilt from the full set\n\n**245 open tasks.** Every open row is here; \`tasks()\` paginates at 200 and the\nprevious build of this file stopped at that boundary, dropping 48 rows.\n\nAge = time since last notify. Sorted newest first inside each topic.\n**Status is a mark on the row, not a section.**\n\n| mark | meaning |\n|---|---|\n| **live** | still real, still wanted, someone should own it |\n| done, unclosed | the work happened — evidence in the row |\n| superseded | overtaken by later work or a later decision |\n| unestablished | I could not determine it. Not a guess either way |\n\nDispositions carry their evidence. A row marked \`unestablished\` has had no\nevidence read yet — it is an honest gap, not a verdict.\n\n`;
out += fs.readFileSync('findings.md','utf8') + '\n---\n\n';
let counts={};
for(const [name] of TOPICS.concat([['Unclassified']])){
  const rows = groups[name]; if(!rows) continue;
  rows.sort((a,b)=>(a.ageMin??1e9)-(b.ageMin??1e9));
  const n = rows.length;
  const dn = rows.filter(r=>D[r.id]).length;
  out += `## ${name} — ${n}${dn?`, ${dn} with evidence`:''}\n\n| age | status | owner | owner state | task | evidence |\n|---|---|---|---|---|---|\n`;
  for(const r of rows){
    const d = D[r.id];
    const mark = d ? MARK[d[0]] : MARK.unestablished;
    const ev = d ? d[1] : '—';
    const title = (r.realTitle ? r.realTitle : r.title).replace(/\|/g,'\\|');
    out += `| ${age(r.ageMin)} | ${mark} | \`${r.ownerName}\` | ${r.ownerState||'—'} | ${title} | ${ev} |\n`;
    counts[d?d[0]:'unestablished']=(counts[d?d[0]:'unestablished']||0)+1;
  }
  out += '\n';
}
out += `---\n\n## Totals\n\n| mark | rows |\n|---|---|\n`;
for(const k of ['live','done','superseded','unestablished']) if(counts[k]) out += `| ${MARK[k]} | ${counts[k]} |\n`;
out += `| **all** | ${tasks.length} |\n`;
fs.writeFileSync('/Users/skip/work/tlda/scratch/open-tasks-by-topic-full.md', out);
console.log('written. rows:', tasks.length, JSON.stringify(counts));
for(const k in groups) console.log('  ', groups[k].length, k);
