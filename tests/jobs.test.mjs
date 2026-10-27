import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const getPort=()=>new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});

test('模拟模型可完成多任务，队列串行（不代表真实 Basic Pitch 推理）',async()=>{
  const modelPort=await getPort(),nodePort=await getPort(),dataDir=await mkdtemp(path.join(tmpdir(),'suiyin-jobs-'));
  let active=0,maxActive=0;
  const fake=http.createServer(async(req,res)=>{
    if(req.url==='/health') {res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');return;}
    for await(const chunk of req){};
    active++;maxActive=Math.max(maxActive,active);await sleep(60);active--;
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({model:'FAKE_MODEL_FOR_TEST_ONLY',noteCount:1,notes:[{pitch:60,startMs:0,endMs:100,confidence:0.5}],inferenceMs:60}));
  });
  await new Promise(resolve=>fake.listen(modelPort,'127.0.0.1',resolve));
  const proc=spawn(process.execPath,['server.cjs'],{cwd:root,env:{...process.env,PORT:String(nodePort),DATA_DIR:dataDir,MODEL_URL:`http://127.0.0.1:${modelPort}`},stdio:'ignore'});
  const base=`http://127.0.0.1:${nodePort}`;
  try {
    let ok=false;
    for(let n=0;n<100;n++){try{if((await fetch(base+'/api/health')).ok){ok=true;break;}}catch{}await sleep(20);}
    assert.ok(ok,'Node API ready');
    const wav=Buffer.alloc(44);wav.write('RIFF',0);wav.write('WAVE',8);
    const started=await Promise.all(Array.from({length:3},()=>fetch(base+'/api/jobs/transcriptions',{method:'POST',headers:{'Content-Type':'audio/wav'},body:wav}).then(async r=>({status:r.status,data:await r.json()}))));
    assert.ok(started.every(x=>x.status===202));
    const ids=started.map(x=>x.data.jobId);
    let state=[];
    for(let n=0;n<120;n++){
      state=await Promise.all(ids.map(id=>fetch(`${base}/api/jobs/${id}`).then(r=>r.json())));
      if(state.every(x=>x.status==='completed'))break;
      await sleep(15);
    }
    assert.ok(state.every(x=>x.status==='completed'),JSON.stringify(state));
    assert.equal(maxActive,1,'每次最多有一条模型推理');
    assert.ok(state.every(x=>x.result?.model==='FAKE_MODEL_FOR_TEST_ONLY'));
  } finally {
    const done=new Promise(resolve=>proc.once('exit',resolve));proc.kill();await done;
    await new Promise(resolve=>fake.close(resolve));await rm(dataDir,{recursive:true,force:true});
  }
});
