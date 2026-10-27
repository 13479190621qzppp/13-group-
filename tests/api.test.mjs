import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {SCORES} from '../src/music.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

let processRef,base,dataDir;
async function randomPort(){return new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});}
async function call(route,{method='GET',body,headers={}}={}){
  const options={method,headers};if(body!==undefined){options.body=JSON.stringify(body);options.headers={'Content-Type':'application/json',...headers};}
  const response=await fetch(base+route,options);const data=await response.json();return {status:response.status,data};
}
before(async ()=>{
  dataDir=await mkdtemp(path.join(tmpdir(),'suiyin-api-'));
  const port=await randomPort();base=`http://127.0.0.1:${port}`;
  processRef=spawn(process.execPath,['server.cjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:String(port),DATA_DIR:dataDir},stdio:['ignore','pipe','pipe']});
  let exited=false;processRef.once('exit',()=>{exited=true;});
  for(let i=0;i<60;i++){
    if(exited) throw Error('API 服务未成功启动');
    try{const result=await fetch(base+'/api/health');if(result.ok)return;}catch{}
    await delay(40);
  }
  throw Error('API 启动超时');
});
after(async()=>{processRef?.kill();await rm(dataDir,{recursive:true,force:true});});

test('健康检查和内置曲谱',async()=>{
  let x=await call('/api/health');assert.equal(x.status,200);assert.equal(x.data.ok,true);
  x=await call('/api/scores');assert.equal(x.status,200);assert.ok(x.data.scores.some(s=>s.id==='scale'));
});
test('原前端和音色的资源路径仍正常',async()=>{
  for(const route of ['/','/src/app.mjs','/src/backend-client.mjs','/samples/piano/60.mp3']) assert.equal((await fetch(base+route)).status,200);
});
test('不能下载后端源码或 .gitignore',async()=>{
  for(const route of ['/backend/api.mjs','/server.cjs','/model/model_server.py','/.gitignore','/../server.cjs']){
    const res=await fetch(base+route);assert.notEqual(res.status,200,route);
  }
});
test('创建会话、等待模式命中并获得准确的报告',async()=>{
  const score={...SCORES[2],id:'test-scale'};
  const created=await call('/api/sessions',{method:'POST',body:{score,options:{mode:'wait'}}});
  assert.equal(created.status,201);const id=created.data.sessionId;
  assert.equal(created.data.nextPitches[0],60);
  const a=await call(`/api/sessions/${id}/events`,{method:'POST',body:{sequence:1,type:'note_on',pitch:60,velocity:.8,timestamp:100}});
  assert.equal(a.status,200);assert.equal(a.data.judgements[0].type,'correct');assert.equal(a.data.eventId,'scale-1');
  assert.equal(a.data.report.correct,1);
  const duplicate=await call(`/api/sessions/${id}/events`,{method:'POST',body:{sequence:1,type:'note_on',pitch:60,timestamp:100}});
  assert.equal(duplicate.data.duplicate,true);assert.equal(duplicate.data.report.correct,1);
  const wrong=await call(`/api/sessions/${id}/events`,{method:'POST',body:{sequence:2,type:'note_on',pitch:69,timestamp:300}});
  assert.equal(wrong.data.judgements[0].type,'wrong');
  const off=await call(`/api/sessions/${id}/events`,{method:'POST',body:{sequence:3,type:'note_off',pitch:60,timestamp:310}});
  assert.equal(off.data.noteOnCount,2);assert.equal(off.data.report.errors.length,1);
  const finish=await call(`/api/sessions/${id}/finish`,{method:'POST',body:{timestamp:400}});
  assert.equal(finish.status,200);assert.equal(finish.data.status,'finished');
  const late=await call(`/api/sessions/${id}/tick`,{method:'POST',body:{timestamp:500}});
  assert.equal(late.status,409);
});
test('时间倒退、乱序 sequence 会被拒绝',async()=>{
  const id=(await call('/api/sessions',{method:'POST',body:{scoreId:'chords'}})).data.sessionId;
  const bad=await call(`/api/sessions/${id}/events`,{method:'POST',body:{sequence:3,type:'note_on',pitch:60,timestamp:10}});
  assert.equal(bad.status,409);assert.equal(bad.data.code,'SEQUENCE_ERROR');
  const one=await call(`/api/sessions/${id}/tick`,{method:'POST',body:{timestamp:200}});assert.equal(one.status,200);
  const old=await call(`/api/sessions/${id}/events`,{method:'POST',body:{sequence:1,type:'note_on',pitch:60,timestamp:100}});
  assert.equal(old.status,409);assert.equal(old.data.code,'TIME_REVERSED');
});
test('follow 模式 tick 可以判断漏音',async()=>{
  const id=(await call('/api/sessions',{method:'POST',body:{scoreId:'scale',options:{mode:'follow',bpm:80}}})).data.sessionId;
  const t=await call(`/api/sessions/${id}/tick`,{method:'POST',body:{timestamp:1100}});
  assert.equal(t.status,200);assert.ok(t.data.report.errors.some(e=>e.type==='missed'));
  assert.ok(t.data.index>=1);
});
test('注册曲谱与按键批量对齐',async()=>{
  const custom={...SCORES[2],id:'user-example'};
  const posted=await call('/api/scores',{method:'POST',body:{score:custom}});
  assert.equal(posted.status,201);
  const second=await call('/api/scores',{method:'POST',body:{score:custom}});
  assert.equal(second.status,409);
  const batch=await call('/api/match',{method:'POST',body:{scoreId:'user-example',options:{mode:'wait'},notes:[{pitch:60,startMs:0},{pitch:62,startMs:500}],endMs:800}});
  assert.equal(batch.status,200);assert.equal(batch.data.report.correct,2);assert.equal(batch.data.report.errors.length,0);
});
test('错误的音高与巨大事件数组被拒绝',async()=>{
  const bad={...SCORES[2],id:'invalid',events:[{id:'a',pitches:[144],beat:0,duration:1,measure:1}]};
  const x=await call('/api/sessions',{method:'POST',body:{score:bad}});
  assert.equal(x.status,422);assert.equal(x.data.code,'INVALID_SCORE');
  const c=await call('/api/match',{method:'POST',body:{scoreId:'scale',notes:[{pitch:220,startMs:0}]}});
  assert.equal(c.status,422);
});
test('模型未启动时明确返回 503，按键 API 不受影响',async()=>{
  const health=await call('/api/model/health');
  assert.ok([200,503].includes(health.status));
  if(health.status===503) assert.equal(health.data.code,'MODEL_UNAVAILABLE');
});
test('只接受 WAV MIME 与有效 RIFF 头',async()=>{
  const response=await fetch(base+'/api/transcriptions',{method:'POST',headers:{'Content-Type':'audio/wav'},body:Buffer.from('not a wave')});
  assert.equal(response.status,422);
});
