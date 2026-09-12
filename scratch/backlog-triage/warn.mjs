import fs from 'fs';
const tasks = JSON.parse(fs.readFileSync('tasks.json','utf8'));
const text = fs.readFileSync('page1.txt','utf8')+fs.readFileSync('page2.txt','utf8');
const map={};
for(const m of text.matchAll(/^\[([^\]]+)\][^\n]*$/gm)){
  const line=m[0], id=m[1];
  if(/is hibernating with an active task/.test(line)) map[id]='owner hibernating';
  else if(/is marked dead/.test(line)) map[id]='owner dead';
  else if(/still pending \d+m after notify/.test(line)) map[id]='never picked up';
  else map[id]='';
}
let c={};
for(const t of tasks){ t.ownerState = map[t.id]||''; c[t.ownerState]=(c[t.ownerState]||0)+1; }
fs.writeFileSync('tasks.json', JSON.stringify(tasks,null,1));
console.log(c);
