import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function randomPort(){return new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function boot(port,dir){
  const proc=spawn(process.execPath,['server.cjs'],{cwd:root,env:{...process.env,PORT:String(port),DATA_DIR:dir,MODEL_URL:'http://127.0.0.1:9'},stdio:'ignore'});
  const base=`http://127.0.0.1:${port}`;
  for(let k=0;k<100;k++){
    if(proc.exitCode!==null)throw Error('server exited before ready');
    try{const res=await fetch(base+'/api/health');if(res.ok)return {proc,base};}catch{}
    await sleep(30);
  }
  proc.kill();throw Error('server startup timeout');
}
async function req(base,url,method='GET',body=null,isWav=false){
  const res=await fetch(base+url,{method,headers:body?{'Content-Type':isWav?'audio/wav':'application/json'}:{},body:body?(isWav?body:JSON.stringify(body)):undefined});
  return {status:res.status,data:await res.json()};
}
async function stop(proc){
  if(proc.exitCode!==null)return;
  const done=new Promise(resolve=>proc.once('exit',resolve));proc.kill();await done;
}

test('自定义曲谱和结束报告落盘并可随进程重启恢复；任务队列异步返回状态',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'suiyin-storage-'));
  const port=await randomPort();
  let current;
  try {
    current=await boot(port,dir);
    const base=current.base;
    const score={id:'persistent-demo',title:'重启后仍存在',bpm:80,measures:1,events:[{id:'p1',pitches:[60],beat:0,duration:1,measure:1}]};
    assert.equal((await req(base,'/api/scores','POST',{score})).status,201);
    const session=await req(base,'/api/sessions','POST',{scoreId:'persistent-demo'});
    assert.equal(session.status,201);
    const id=session.data.sessionId;
    assert.equal((await req(base,`/api/sessions/${id}/events`,'POST',{sequence:1,type:'note_on',pitch:60,timestamp:100})).status,200);
    assert.equal((await req(base,`/api/sessions/${id}/finish`,'POST',{timestamp:200})).status,200);
    const saved=JSON.parse(await readFile(path.join(dir,'backend-records.json'),'utf8'));
    assert.equal(saved.reports.length,1);
    assert.equal(saved.reports[0].report.correct,1);
    assert.equal(saved.scores[0].id,'persistent-demo');
    // 合成最小 RIFF/WAVE 头，用于验证排队接口和模型异常返回，而非验证模型推理。
    const wav=Buffer.alloc(44);wav.write('RIFF',0);wav.write('WAVE',8);
    const started=await req(base,'/api/jobs/transcriptions','POST',wav,true);
    assert.equal(started.status,202);
    let job;
    for(let i=0;i<50;i++){
      job=await req(base,`/api/jobs/${started.data.jobId}`);
      if(job.data.status==='failed'||job.data.status==='completed')break;
      await sleep(20);
    }
    assert.equal(job.status,200);
    assert.equal(job.data.status,'failed'); // 故意未启动模型：不得伪造转录结果。
    await stop(current.proc);current=null;
    current=await boot(port,dir);
    const listing=await req(current.base,'/api/scores');
    assert.ok(listing.data.scores.some(s=>s.id==='persistent-demo'));
    const report=await req(current.base,`/api/reports/${id}`);
    assert.equal(report.status,200);assert.equal(report.data.report.correct,1);
  } finally {if(current)await stop(current.proc);await rm(dir,{recursive:true,force:true});}
});
