/** 实测脚本：HTTP 端到端延迟 + 后端规则处理耗时，模型可选。 */
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=await new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const base=`http://127.0.0.1:${port}`;
const proc=spawn(process.execPath,['server.cjs'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:'ignore'});
const isNumber=v=>Number.isFinite(v);
const round=v=>Math.round(v*1000)/1000;
const summarize=values=>{
  const arr=values.filter(isNumber).sort((a,b)=>a-b);
  if(!arr.length)return null;
  return {count:arr.length,avgMs:round(arr.reduce((a,b)=>a+b,0)/arr.length),p50Ms:round(arr[Math.floor((arr.length-1)*.5)]),p95Ms:round(arr[Math.floor((arr.length-1)*.95)]),p99Ms:round(arr[Math.floor((arr.length-1)*.99)]),maxMs:round(arr.at(-1))};
};
async function request(url,options){const started=performance.now();const response=await fetch(base+url,options);const data=await response.json();if(!response.ok)throw Error(`${url}: ${response.status} ${data.message}`);return {data,elapsed:performance.now()-started};}
function json(body){return {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};}
function generateWav(seconds=1.5,rate=22050){
  const length=Math.floor(seconds*rate),buf=Buffer.alloc(44+length*2);
  buf.write('RIFF',0);buf.writeUInt32LE(buf.length-8,4);buf.write('WAVEfmt ',8);buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);buf.writeUInt16LE(1,22);buf.writeUInt32LE(rate,24);buf.writeUInt32LE(rate*2,28);buf.writeUInt16LE(2,32);buf.writeUInt16LE(16,34);buf.write('data',36);buf.writeUInt32LE(length*2,40);
  for(let i=0;i<length;i++){
    const freq=i<length/2?261.626:329.628;
    const amp=Math.sin(2*Math.PI*freq*i/rate)*Math.min(1,i/(rate*.03))*Math.min(1,(length-i)/(rate*.05));
    buf.writeInt16LE(Math.round(amp*12000),44+i*2);
  }
  return buf;
}
try {
  for(let i=0;i<100;i++){
    if(proc.exitCode !== null)throw Error('Node 服务已退出');
    try{await request('/api/health');break;}catch{if(i===99)throw Error('后端未启动');await sleep(40);}
  }
  const events=Array.from({length:180},(_,i)=>({id:`bench-${i}`,pitches:[60],beat:i,duration:1,measure:Math.floor(i/4)+1}));
  const score={id:'bench',title:'性能测试合成练习',events,bpm:120,beats:4,beatType:4,measures:45};
  const created=await request('/api/sessions',json({score,options:{mode:'wait'}}));const id=created.data.sessionId;
  const roundTrips=[],processing=[],iterations=100,warmup=10;
  for(let i=0;i<iterations+warmup;i++){
    const seq=i+1,body={type:'note_on',sequence:seq,pitch:60,velocity:.8,timestamp:i*40};
    const r=await request(`/api/sessions/${id}/events`,json(body));
    if(i>=warmup){roundTrips.push(r.elapsed);processing.push(r.data.processingMs);}
  }
  const result={
    generatedAt:new Date().toISOString(),node:process.version,platform:process.platform,architecture:process.arch,
    remark:'测试对象是回环 HTTP 单次请求；包括服务器 JSON 序列化和网络栈，但不代表实际键盘/声卡/麦克风端到端延迟。前 10 次不计入统计。',
    api:{requestRoundTrip:summarize(roundTrips),serverProcessing:summarize(processing)},
    model:{status:'not_tested',reason:'模型未安装或未启动'}
  };
  if(process.argv.includes('--with-model')){
    const audio=generateWav();
    try {
      const r=await request('/api/transcriptions',{method:'POST',headers:{'Content-Type':'audio/wav'},body:audio,signal:AbortSignal.timeout(90000)});
      result.model={status:'measured',waveSeconds:1.5,noteCount:r.data.noteCount,modelInferenceMs:r.data.inferenceMs,modelServiceMs:r.data.totalModelServiceMs,completeHttpRoundTripMs:round(r.elapsed),realTimeFactor:round(r.data.inferenceMs/1500)};
    }catch(e){result.model={status:'unavailable',reason:e.message};}
  }
  const outfile=path.join(root,'benchmarks','last-run.json');
  await mkdir(path.dirname(outfile),{recursive:true});await writeFile(outfile,JSON.stringify(result,null,2));
  console.log('\n随音 · 后端性能实测');console.log(JSON.stringify(result,null,2));
  console.log(`\n结果已写入 ${outfile}`);
}finally{proc.kill();}
