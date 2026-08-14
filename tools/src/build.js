const fs = require('fs');
const S = '/tmp/claude-0/-home-user-ClaudeCode/52dad5b8-8522-51a9-8868-eb5ca9c60f0f/scratchpad';
const D = S + '/data';

const read = f => JSON.parse(fs.readFileSync(D + '/' + f, 'utf8'));
const tasks = [...read('tasks-nyuka-zaiko.json'), ...read('tasks-shukka.json'), ...read('tasks-ht-sd-ec.json')];

// カテゴリ表示順で安定ソート
const catOrder = ['入荷','出荷','在庫','補充','棚卸','日次','マスタ','共通操作','HT','SD','EC受注','帳票・ラベル'];
tasks.sort((a,b)=> (catOrder.indexOf(a.cat)-catOrder.indexOf(b.cat)) || 0);

// ID重複チェック
const seen = new Set();
tasks.forEach(t => { if(seen.has(t.id)) throw new Error('duplicate task id: '+t.id); seen.add(t.id); });

const trouble = read('trouble.json');
// 診断ツリーの参照整合チェック
trouble.forEach(t => {
  if(t.nodes){
    if(!t.start || !t.nodes[t.start]) throw new Error('bad start: '+t.id);
    Object.entries(t.nodes).forEach(([nid,n]) => (n.opts||[]).forEach(o => {
      if(o.next && !t.nodes[o.next]) throw new Error('dangling next '+o.next+' in '+t.id);
      if(!o.next && !o.result) throw new Error('opt without next/result in '+t.id+'/'+nid);
    }));
  } else if(!t.result) throw new Error('tree without nodes/result: '+t.id);
});

const glossary = read('glossary.json');
const params = read('params.json');

const DB = { tasks, trouble, glossary, params };
const shell = fs.readFileSync(S + '/shell.html', 'utf8');
if(!shell.includes('__DB__')) throw new Error('placeholder missing');
const json = JSON.stringify(DB).replace(/</g, '\\u003c');
const out = shell.replace('__DB__', json);
fs.writeFileSync('/home/user/ClaudeCode/tools/wms-quickstart.html', out);
console.log('OK tasks=%d trouble=%d glossary=%d params=%d bytes=%d',
  tasks.length, trouble.length, glossary.length, params.length, out.length);
