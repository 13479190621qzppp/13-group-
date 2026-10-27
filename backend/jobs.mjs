/** 音频任务队列：单模型实例串行推理，限制队列数，异步轮询。仅本地进程保存任务。 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export function createJobQueue(worker,{maxQueued=3,ttlMs=30*60*1000}={}) {
  const jobs = new Map(), waiting = [];
  let active = false;
  function prune() {
    const now = Date.now();
    for (const [id,job] of jobs) {
      if (['completed','failed'].includes(job.status) && now-job.finishedAtEpoch>ttlMs) jobs.delete(id);
    }
  }
  function view(job) {
    if (!job) return null;
    const {id,status,createdAt,startedAt,finishedAt,queueWaitMs,executionMs,result,error}=job;
    return {jobId:id,status,createdAt,startedAt,finishedAt,queueWaitMs,executionMs,
      ...(result?{result}:{}),...(error?{error}:{})};
  }
  async function pump() {
    if (active) return;
    active = true;
    while (waiting.length) {
      const job=waiting.shift();
      job.status='running';job.startedAt=new Date().toISOString();
      job.queueWaitMs=Date.now()-job.createdAtEpoch;
      const start=performance.now();
      try {job.result=await worker(job.audio);job.status='completed';}
      catch(e){job.error={code:'MODEL_JOB_FAILED',message:String(e.message||e).slice(0,250)};job.status='failed';}
      finally {job.audio=null;job.executionMs=Number((performance.now()-start).toFixed(3));job.finishedAt=new Date().toISOString();job.finishedAtEpoch=Date.now();}
    }
    active = false;
  }
  return {
    enqueue(audio) {
      prune();
      if (waiting.length>=maxQueued) return null;
      const job={id:randomUUID(),audio,status:'queued',createdAt:new Date().toISOString(),createdAtEpoch:Date.now()};
      jobs.set(job.id,job);waiting.push(job);
      queueMicrotask(()=>{void pump();});
      return view(job);
    },
    get(id){prune();return view(jobs.get(id));},
    summary(){prune();return {queued:waiting.length,running:active?1:0,retained:jobs.size,maxQueued};}
  };
}
