/** 随音 HTTP API：沿用浏览器 PracticeEngine，避免两套评分口径。仅单机演示，不含账户鉴权。 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PracticeEngine } from '../src/engine.mjs';
import { SCORES } from '../src/music.mjs';
import { openStorage } from './storage.mjs';
import { createJobQueue } from './jobs.mjs';

const MAX_JSON = 2 * 1024 * 1024;
const MAX_AUDIO = 5 * 1024 * 1024;
const MAX_SESSIONS = 200;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const scoreLibrary = new Map(SCORES.map(s => [s.id, structuredClone(s)]));
const sessions = new Map();

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function ensure(test, status, code, message) { if (!test) throw new ApiError(status, code, message); }
const finite = x => typeof x === 'number' && Number.isFinite(x);
function json(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
  res.end(data);
}
async function readBody(req, limit) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new ApiError(413, 'TOO_LARGE', '请求体超过大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  ensure((req.headers['content-type'] || '').split(';')[0].trim() === 'application/json', 415, 'JSON_REQUIRED', '请使用 Content-Type: application/json');
  let body;
  try { body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8')); }
  catch(e) { if (e instanceof ApiError) throw e; throw new ApiError(400, 'INVALID_JSON', 'JSON 格式无效'); }
  ensure(body && typeof body === 'object' && !Array.isArray(body), 422, 'INVALID_BODY', '请求内容应为 JSON 对象');
  return body;
}
function validateScore(s) {
  ensure(s && typeof s === 'object' && !Array.isArray(s), 422, 'INVALID_SCORE', 'score 必须是对象');
  ensure(typeof s.id === 'string' && s.id.length >= 1 && s.id.length <= 120, 422, 'INVALID_SCORE', '曲谱 id 无效');
  ensure(typeof s.title === 'string' && s.title.length >= 1 && s.title.length <= 120, 422, 'INVALID_SCORE', '曲谱 title 无效');
  ensure(Array.isArray(s.events) && s.events.length > 0 && s.events.length <= 3000, 422, 'INVALID_SCORE', '曲谱事件数应在 1~3000 之间');
  ensure(finite(s.bpm) && s.bpm >= 30 && s.bpm <= 200, 422, 'INVALID_SCORE', '曲谱 bpm 应在 30~200 之间');
  ensure(Number.isInteger(s.measures) && s.measures >= 1 && s.measures <= 3000, 422, 'INVALID_SCORE', '曲谱 measures 无效');
  let lastBeat = -1;
  const ids = new Set();
  for (const e of s.events) {
    ensure(e && typeof e === 'object' && typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 140 && !ids.has(e.id), 422, 'INVALID_SCORE', '音符组 ID 不能为空或重复');
    ids.add(e.id);
    ensure(finite(e.beat) && e.beat >= lastBeat && finite(e.duration) && e.duration > 0 && e.duration <= 1000, 422, 'INVALID_SCORE', '音符组时间无效或未排序');
    ensure(Number.isInteger(e.measure) && e.measure >= 1 && e.measure <= s.measures, 422, 'INVALID_SCORE', '小节编号越界');
    ensure(Array.isArray(e.pitches) && e.pitches.length <= 16 && e.pitches.every(p => Number.isInteger(p) && p >= 0 && p <= 127) && new Set(e.pitches).size === e.pitches.length, 422, 'INVALID_SCORE', '音高应为 MIDI 0~127 且不能重复');
    lastBeat = e.beat;
  }
  ensure(s.events.some(e => e.pitches.length > 0), 422, 'INVALID_SCORE', '没有可演奏音符');
  return structuredClone(s);
}
function validateOptions(value, score) {
  const opts = value || {};
  ensure(opts && typeof opts === 'object' && !Array.isArray(opts), 422, 'INVALID_OPTIONS', 'options 应为对象');
  const { mode = 'wait', bpm = score.bpm, tolerance = 250, chordWindow = 160, loop = null } = opts;
  ensure(['wait', 'follow'].includes(mode), 422, 'INVALID_OPTIONS', '仅支持 wait 或 follow 会话');
  ensure(finite(bpm) && bpm >= 30 && bpm <= 200, 422, 'INVALID_OPTIONS', 'bpm 应在 30~200');
  ensure(finite(tolerance) && tolerance >= 50 && tolerance <= 1000, 422, 'INVALID_OPTIONS', 'tolerance 应在 50~1000 ms');
  ensure(finite(chordWindow) && chordWindow >= 50 && chordWindow <= 500, 422, 'INVALID_OPTIONS', 'chordWindow 应在 50~500 ms');
  ensure(loop === null || (Array.isArray(loop) && loop.length === 2 && loop.every(Number.isInteger) && loop[0] >= 1 && loop[1] >= loop[0] && loop[1] <= score.measures), 422, 'INVALID_OPTIONS', 'loop 小节区间无效');
  return { mode, bpm, tolerance, chordWindow, loop };
}
function publicScore(s) { return {id:s.id, title:s.title, bpm:s.bpm, measures:s.measures, events:s.events.length}; }
function snapshot(s, decision = null, processingMs = null) {
  const { engine:e } = s;
  return {
    sessionId:s.id, scoreId:s.score.id, sequence:s.sequence, status:s.status,
    index:e.index, done:e.done,
    eventId:e.current?.id ?? null, measure:e.current?.measure ?? null,
    nextPitches:e.current?.pitches ?? [],
    judgements:decision ? [decision] : [],
    errors:[...e.errors], results:[...e.results], matched:[...e.matched],
    report:e.report(s.elapsed), elapsed:s.elapsed, processingMs,
    eventCount:s.eventCount, noteOnCount:s.noteOnCount
  };
}
function prune() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.touched > SESSION_TTL_MS) sessions.delete(id);
  if (sessions.size >= MAX_SESSIONS) {
    const sorted = [...sessions.values()].sort((a,b) => a.touched - b.touched);
    for (const s of sorted.slice(0, sessions.size - MAX_SESSIONS + 1)) sessions.delete(s.id);
  }
}
function loadSession(id) {
  const s = sessions.get(id);
  ensure(s, 404, 'SESSION_NOT_FOUND', '会话不存在或已过期');
  s.touched = Date.now();
  return s;
}
function checkTime(s, time) {
  ensure(finite(time) && time >= 0 && time <= 24*60*60*1000, 422, 'INVALID_TIMESTAMP', 'timestamp 应为非负毫秒');
  ensure(time + 0.01 >= s.elapsed, 409, 'TIME_REVERSED', '服务端收到倒退的练习时钟');
}
function scoreFromBody(body) {
  if (body.score) return validateScore(body.score);
  ensure(typeof body.scoreId === 'string', 422, 'SCORE_REQUIRED', '请提供 scoreId 或 score');
  const score = scoreLibrary.get(body.scoreId);
  ensure(score, 404, 'SCORE_NOT_FOUND', '曲谱不存在');
  return score;
}
function cleanEvent(event) {
  ensure(event && typeof event === 'object', 422, 'INVALID_EVENT', '演奏事件格式无效');
  ensure(['note_on', 'note_off'].includes(event.type), 422, 'INVALID_EVENT', 'type 只能是 note_on/note_off');
  ensure(Number.isInteger(event.pitch) && event.pitch >= 0 && event.pitch <= 127, 422, 'INVALID_EVENT', 'pitch 应为 MIDI 0~127');
  ensure(finite(event.timestamp), 422, 'INVALID_EVENT', 'timestamp 必须是毫秒数');
  ensure(Number.isInteger(event.sequence) && event.sequence >= 1, 422, 'INVALID_EVENT', 'sequence 应为从 1 开始的整数');
  ensure(event.velocity === undefined || (finite(event.velocity) && event.velocity >= 0 && event.velocity <= 1), 422, 'INVALID_EVENT', 'velocity 应为 0~1');
  return event;
}
function scoreMatch(body) {
  const score = scoreFromBody(body);
  const opts = validateOptions(body.options || {mode:'follow'}, score);
  ensure(Array.isArray(body.notes) && body.notes.length <= 4000, 422, 'INVALID_NOTES', 'notes 必须是至多 4000 个音符的数组');
  let old = -1;
  const engine = new PracticeEngine(score, opts);
  const judgements = [];
  for (const note of body.notes) {
    ensure(note && Number.isInteger(note.pitch) && note.pitch >= 0 && note.pitch <= 127 && finite(note.startMs) && note.startMs >= old && note.startMs >= 0, 422, 'INVALID_NOTES', 'notes 必须按 startMs 升序排列');
    old = note.startMs;
    judgements.push({...engine.noteOn(note.pitch, note.startMs),startMs:note.startMs});
  }
  const endMs = body.endMs ?? (old >= 0 ? old : 0);
  ensure(finite(endMs) && endMs >= old && endMs <= 24*60*60*1000, 422, 'INVALID_TIMESTAMP', 'endMs 无效');
  engine.tick(endMs);
  return { scoreId:score.id, options:opts, judgements, index:engine.index, done:engine.done, report:engine.report(endMs) };
}

export async function createApi({ modelUrl = process.env.MODEL_URL || 'http://127.0.0.1:8765' } = {}) {
  const storage = await openStorage();
  for (const score of storage.getScores()) scoreLibrary.set(score.id,validateScore(score));
  async function runModel(wav) {
    const response=await fetch(`${modelUrl}/transcribe`,{method:'POST',headers:{'Content-Type':'audio/wav'},body:wav,signal:AbortSignal.timeout(90000)});
    let body;
    try { body=await response.json(); } catch { throw new Error('模型未返回有效 JSON'); }
    if (!response.ok) throw new Error(`模型 HTTP ${response.status}: ${body.message||'处理失败'}`);
    return body;
  }
  const jobs = createJobQueue(runModel);
  return async function handleApi(req,res,pathname) {
    const start = performance.now();
    try {
      const method = req.method.toUpperCase();
      if (pathname === '/api/health' && method === 'GET') {
        json(res, 200, {ok:true, service:'suiyin-node', model:'optional-python-basic-pitch', uptimeSec:Math.round(process.uptime()), sessions:sessions.size, scores:scoreLibrary.size, persistedReports:storage.getReports().length, storage:'local-json', jobs:jobs.summary()}); return;
      }
      if (pathname === '/api/scores' && method === 'GET') { json(res, 200, {scores:[...scoreLibrary.values()].map(publicScore)});return; }
      if (pathname === '/api/scores' && method === 'POST') {
        const score = validateScore((await readJson(req)).score);
        ensure(!scoreLibrary.has(score.id), 409, 'SCORE_EXISTS', '已有相同 scoreId 的曲谱');
        ensure(scoreLibrary.size < 250, 429, 'SCORE_LIMIT', '演示服务最多注册 250 首曲谱');
        await storage.addScore(score); scoreLibrary.set(score.id,score); json(res,201,{score:publicScore(score),persisted:true});return;
      }
      if (pathname === '/api/reports' && method === 'GET') {
        json(res,200,{reports:storage.getReports().map(({sessionId,scoreId,finishedAt,report})=>({sessionId,scoreId,finishedAt,accuracy:report.accuracy,correct:report.correct,judged:report.judged}))});return;
      }
      const reportRoute = /^\/api\/reports\/([0-9a-f-]{36})$/.exec(pathname);
      if (reportRoute && method === 'GET') {
        const report = storage.getReports().find(r=>r.sessionId===reportRoute[1]);
        ensure(report,404,'REPORT_NOT_FOUND','没有这份已完成的报告');
        json(res,200,report);return;
      }
      if (pathname === '/api/sessions' && method === 'POST') {
        const body=await readJson(req);
        const score=scoreFromBody(body), options=validateOptions(body.options,score);
        prune();
        const id=randomUUID(),engine=new PracticeEngine(score,options);
        const s={id,score,engine,options,sequence:0,elapsed:0,eventCount:0,noteOnCount:0,status:'active',touched:Date.now(),lastResponse:null};
        sessions.set(id,s);
        json(res,201,{...snapshot(s,null,performance.now()-start),options});return;
      }
      if (pathname === '/api/match' && method === 'POST') {
        const result=scoreMatch(await readJson(req));
        json(res,200,{...result,processingMs:Number((performance.now()-start).toFixed(3))});return;
      }
      if (pathname === '/api/model/health' && method === 'GET') {
        try {
          const response=await fetch(`${modelUrl}/health`,{signal:AbortSignal.timeout(1500)});
          ensure(response.ok,503,'MODEL_UNAVAILABLE','模型服务没有正常响应');
          json(res,200,{connected:true,...await response.json()});
        }catch{json(res,503,{connected:false,code:'MODEL_UNAVAILABLE',message:'未检测到 Python Basic Pitch 模型服务；Node 后端和按键练习仍可使用'});}return;
      }
      if (pathname === '/api/transcriptions' && method === 'POST') {
        ensure((req.headers['content-type']||'').split(';')[0].trim()==='audio/wav',415,'WAV_REQUIRED','请上传 audio/wav 的 WAV 文件');
        const wav=await readBody(req,MAX_AUDIO);
        ensure(wav.length >= 44 && wav.toString('ascii',0,4)==='RIFF' && wav.toString('ascii',8,12)==='WAVE',422,'INVALID_WAV','请上传有效的 RIFF/WAV 音频');
        try {
          const response=await fetch(`${modelUrl}/transcribe`,{method:'POST',headers:{'Content-Type':'audio/wav'},body:wav,signal:AbortSignal.timeout(90000)});
          const data=await response.json();
          json(res,response.ok?200:502,{...data, roundTripMs:Number((performance.now()-start).toFixed(3))});
        } catch(error) {json(res,503,{code:'MODEL_UNAVAILABLE',message:'音频模型未启动、连接失败或处理超时',detail:error.name});}
        return;
      }
      if (pathname === '/api/jobs' && method === 'GET') {json(res,200,jobs.summary());return;}
      if (pathname === '/api/jobs/transcriptions' && method === 'POST') {
        ensure((req.headers['content-type']||'').split(';')[0].trim()==='audio/wav',415,'WAV_REQUIRED','请上传 audio/wav');
        const wav=await readBody(req,MAX_AUDIO);
        ensure(wav.length >= 44 && wav.toString('ascii',0,4)==='RIFF' && wav.toString('ascii',8,12)==='WAVE',422,'INVALID_WAV','不是有效的 RIFF/WAV');
        const job=jobs.enqueue(wav);
        ensure(job,429,'JOB_QUEUE_FULL','模型待处理队列已满，请稍后再试');
        json(res,202,{...job,poll:`/api/jobs/${job.jobId}`});return;
      }
      const jobRoute=/^\/api\/jobs\/([0-9a-f-]{36})$/.exec(pathname);
      if (jobRoute && method==='GET') {
        const job=jobs.get(jobRoute[1]);ensure(job,404,'JOB_NOT_FOUND','任务不存在或已清理');
        json(res,200,job);return;
      }
      const match=/^\/api\/sessions\/([0-9a-f-]{36})(?:\/(events|tick|finish))?$/.exec(pathname);
      if (match) {
        const s=loadSession(match[1]), action=match[2];
        if (!action && method==='GET') { json(res,200,snapshot(s,null,performance.now()-start)); return; }
        if (!action && method==='DELETE') {sessions.delete(s.id);json(res,200,{deleted:true,sessionId:s.id});return;}
        ensure(s.status==='active',409,'SESSION_FINISHED','此练习已结束，不能继续写入');
        if (action==='events' && method==='POST') {
          const ev=cleanEvent(await readJson(req));
          if (ev.sequence===s.sequence && s.lastResponse) {json(res,200,{...s.lastResponse,duplicate:true});return;}
          ensure(ev.sequence===s.sequence+1,409,'SEQUENCE_ERROR',`sequence 必须为 ${s.sequence+1}`);
          checkTime(s,ev.timestamp);
          s.elapsed=ev.timestamp;
          let judgement={type:'note_off',pitch:ev.pitch};
          if (ev.type==='note_on' && ev.velocity !== 0) {judgement=s.engine.noteOn(ev.pitch,s.elapsed);s.noteOnCount++;}
          else s.engine.tick(s.elapsed);
          s.sequence++;s.eventCount++;
          s.lastResponse=snapshot(s,judgement,Number((performance.now()-start).toFixed(3)));
          json(res,200,s.lastResponse);return;
        }
        if (action==='tick' && method==='POST') {
          const {timestamp}=await readJson(req);
          checkTime(s,timestamp);s.elapsed=timestamp;s.engine.tick(timestamp);
          json(res,200,snapshot(s,null,Number((performance.now()-start).toFixed(3))));return;
        }
        if (action==='finish' && method==='POST') {
          const {timestamp}=await readJson(req);
          checkTime(s,timestamp);s.elapsed=timestamp;
          // 只有持久化成功后才宣布练习完成。
          const finished=snapshot(s,null,Number((performance.now()-start).toFixed(3)));
          await storage.addReport({sessionId:s.id,scoreId:s.score.id,finishedAt:new Date().toISOString(),report:finished.report});
          s.status='finished';
          json(res,200,snapshot(s,null,Number((performance.now()-start).toFixed(3))));return;
        }
      }
      throw new ApiError(404,'API_NOT_FOUND','此 API 不存在');
    } catch(error) {
      if (error instanceof ApiError) {json(res,error.status,{code:error.code,message:error.message});return;}
      if (!res.headersSent) json(res,500,{code:'INTERNAL',message:'服务器内部错误'});
      console.error('[api]',error);
    }
  };
}
