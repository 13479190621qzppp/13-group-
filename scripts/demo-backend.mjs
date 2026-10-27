/** 随音课程汇报：一键检查 Node 后端核心能力，并保存真实 API 证据。 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdir, writeFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// 在空闲端口单独启动一个临时后端，以免影响已打开的网页。
async function freePort(){
  return new Promise((resolve,reject)=>{
    const server=createServer();server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{const n=server.address().port;server.close(()=>resolve(n));});
  });
}
const selectedPort=await freePort();
const base=`http://127.0.0.1:${selectedPort}`;
let logs='';
const server=spawn(process.execPath,['server.cjs'],{
  cwd:root,env:{...process.env,PORT:String(selectedPort)},stdio:['ignore','pipe','pipe']
});
server.stdout.on('data',c=>{logs+=c.toString();});
server.stderr.on('data',c=>{logs+=c.toString();});
let failed=false;
const records=[];
const report={checkedAt:new Date().toISOString(),node:process.version,platform:process.platform,tests:records,
  explanation:'该报告来自运行本脚本的电脑；模型服务不在线不代表 Node API 失败。'};
const print=(name,status,detail='')=>{
  records.push({name,status,detail});
  console.log(`${status==='通过'?'[PASS]':status==='未部署'?'[INFO]':'[FAIL]'} ${name}${detail?'：'+detail:''}`);
};
async function call(route,{method='GET',body}={}){
  const opts={method,signal:AbortSignal.timeout(5000)};
  if(body!==undefined){opts.headers={'Content-Type':'application/json'};opts.body=JSON.stringify(body);}
  const res=await fetch(base+route,opts);
  const result=await res.json();
  return {status:res.status,data:result};
}
async function step(name,fn){
  try{const r=await fn();print(name,'通过',r||'');}
  catch(e){failed=true;print(name,'失败',e.message);}
}
try{
  console.log('========================================');
  console.log(' 随音 | Node.js 后端课程验收演示');
  console.log('========================================');
  console.log('当前 Node.js：'+process.version);
  let online=false;
  for(let i=0;i<100;i++){
    if(server.exitCode!==null)throw Error(`服务启动失败 ${logs}`);
    try{const res=await fetch(base+'/api/health');if(res.ok){online=true;break;}}catch{}
    await sleep(40);
  }
  assert.ok(online,`服务启动超时 ${logs}`);
  let sessionId='', firstDecision=null;
  await step('01 Node API 健康检查',async()=>{
    const r=await call('/api/health');assert.equal(r.status,200);assert.equal(r.data.ok,true);
    report.health=r.data;return '服务正常 / '+r.data.service;
  });
  await step('02 乐谱库服务',async()=>{
    const r=await call('/api/scores');assert.equal(r.status,200);assert.ok(r.data.scores.some(s=>s.id==='scale'));
    report.scores=r.data.scores;return `返回 ${r.data.scores.length} 首曲谱`;
  });
  await step('03 创建练习会话',async()=>{
    const r=await call('/api/sessions',{method:'POST',body:{scoreId:'scale',options:{mode:'wait',bpm:72}}});
    assert.equal(r.status,201);assert.ok(r.data.sessionId);assert.equal(r.data.nextPitches[0],60);
    sessionId=r.data.sessionId;report.session={id:sessionId,scoreId:r.data.scoreId};return '初始目标 C4 / MIDI 60';
  });
  await step('04 note_on 正确音判定',async()=>{
    const r=await call(`/api/sessions/${sessionId}/events`,{method:'POST',body:{sequence:1,type:'note_on',pitch:60,velocity:.8,timestamp:100,source:'keyboard'}});
    assert.equal(r.status,200);assert.equal(r.data.judgements[0].type,'correct');assert.equal(r.data.nextPitches[0],62);
    firstDecision={judgement:r.data.judgements[0],nextPitches:r.data.nextPitches,accuracy:r.data.report.accuracy,processingMs:r.data.processingMs};
    report.correctNote=firstDecision;return `判定 correct / 下一音 D4 / 正确率 ${r.data.report.accuracy}%`;
  });
  await step('05 错音判定与报告',async()=>{
    const r=await call(`/api/sessions/${sessionId}/events`,{method:'POST',body:{sequence:2,type:'note_on',pitch:69,velocity:.8,timestamp:300,source:'keyboard'}});
    assert.equal(r.status,200);assert.equal(r.data.judgements[0].type,'wrong');assert.ok(r.data.report.errors.length>=1);
    report.wrongNote={judgement:r.data.judgements[0],report:r.data.report};return `判定 wrong / 累计错误 ${r.data.report.errors.length} 条`;
  });
  await step('06 离线乐谱匹配',async()=>{
    const r=await call('/api/match',{method:'POST',body:{scoreId:'scale',options:{mode:'wait'},notes:[{pitch:60,startMs:0},{pitch:62,startMs:500}],endMs:800}});
    assert.equal(r.status,200);assert.equal(r.data.report.correct,2);report.match={correct:r.data.report.correct,errors:r.data.report.errors.length,processingMs:r.data.processingMs};
    return `匹配成功 ${r.data.report.correct} 个音符`;
  });
  await step('07 输入校验与错误码',async()=>{
    const r=await call(`/api/sessions/${sessionId}/events`,{method:'POST',body:{sequence:999,type:'note_on',pitch:60,timestamp:400}});
    assert.equal(r.status,409);assert.equal(r.data.code,'SEQUENCE_ERROR');return '非法事件返回 HTTP 409 / SEQUENCE_ERROR';
  });
  await step('08 结束会话',async()=>{
    const r=await call(`/api/sessions/${sessionId}/finish`,{method:'POST',body:{timestamp:500}});
    assert.equal(r.status,200);assert.equal(r.data.status,'finished');report.finalReport=r.data.report;return '后端返回最终练习报告';
  });
  const model=await call('/api/model/health');
  if(model.status===200 && model.data.connected){
    print('09 Basic Pitch 模型连通性','通过','模型服务在线（还需单独执行真实转录来验证推理）');
  }else{
    print('09 Basic Pitch 模型连通性','未部署','Basic Pitch 未启动；不能宣称模型推理验证通过');
  }
  report.model={status:model.status,connected:!!model.data.connected,response:model.data};
}catch(e){failed=true;print('服务启动/验收流程','失败',e.message);}
finally{
  server.kill();
  const dir=path.join(root,'reports');
  await mkdir(dir,{recursive:true});
  const dest=path.join(dir,'后端验收结果.json');
  report.passed=records.filter(x=>x.status==='通过').length;
  report.failed=records.filter(x=>x.status==='失败').length;
  report.modelDeployed=records.some(x=>x.name.startsWith('09')&&x.status==='通过');
  await writeFile(dest,JSON.stringify(report,null,2),'utf8');
  console.log('----------------------------------------');
  console.log(`核心验收：通过 ${report.passed} 项，失败 ${report.failed} 项`);
  console.log(`证据文件：${dest}`);
  console.log('说明：音频模型离线不计入 Node 后端功能失败。');
  console.log('----------------------------------------');
  if(failed)process.exitCode=1;
}
