import { PracticeEngine } from './engine.mjs';
import { AudioEngine } from './audio.mjs';
import { BackendMirror } from './backend-client.mjs';
import { INSTRUMENTS, SCORES, KEY_CODES, keyLabel, noteName, targetsFor, parseMusicXML } from './music.mjs';

const $ = id => document.getElementById(id);
const escape = value => String(value).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ICONS = {
  piano:'M3 4h18v16H3z M7 4v9h3V4 M14 4v9h3V4 M8 13v7 M16 13v7',
  book:'M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1z M12 5v15',
  chart:'M4 3v17h17 M8 15v-4 M13 15V7 M18 15V4',
  help:'M9.5 9a2.5 2.5 0 1 1 4 2c-1.5.8-1.5 1.2-1.5 2 M12 16h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  settings:'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  upload:'M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6',
  download:'M12 3v13 M7 11l5 5 5-5 M4 16v5h16v-5',
  'pause-circle':'M9 9v6 M15 9v6 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  follow:'M3 12h4l3-7 4 14 3-7h4',
  play:'M8 4l12 8-12 8z', pause:'M8 5v14 M16 5v14', stop:'M6 6h12v12H6z',
  restart:'M3 9a9 9 0 1 1 1 8 M3 3v6h6',
  tempo:'M8 3h8l5 17H3z M12 16l6-11 M8 16h8',
  keyboard:'M2 5h20v14H2z M5 9h1 M9 9h1 M13 9h1 M17 9h1 M5 12h1 M9 12h1 M13 12h1 M17 12h1 M7 16h10',
  volume:'M11 4L5 9H2v6h3l6 5z M15 8a6 6 0 0 1 0 8 M18 5a10 10 0 0 1 0 14',
  plug:'M8 3v5 M16 3v5 M5 8h14v3a7 7 0 0 1-14 0z M12 18v4',
  spark:'M12 2l2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z',
  close:'M6 6l12 12 M6 18L18 6', info:'M12 11v6 M12 7h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'
};
function icon(name) { return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] || ICONS.info}"/></svg>`; }
function decorate(root=document) { root.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon)); }
decorate();
const audio = new AudioEngine();
const backend = new BackendMirror(status => { const el=$('backend-status'); if(el) el.textContent=status; });
const modeNames = {wait:'等待模式',follow:'跟弹模式',demo:'示范模式'};
const errorNames = {wrong:'错音',missed:'漏音',extra:'多音',early:'抢拍',late:'拖拍'};
const state = {
  score:SCORES[0], instrument:INSTRUMENTS.piano, mode:'wait', view:'staff', page:'practice',
  engine:null, status:'idle', elapsed:0, started:0, active:new Map(), errors:new Map(), flashes:new Map(),
  base:60, preview:3, sessionSaved:false, demoIndex:0, demoTimers:new Set(), countTimer:null,
  lastBeat:-1, lastUI:0, selectedReport:0, countToken:0, soundPromise:null, loadedInstrument:null,
};
let history=[];
try { const saved=JSON.parse(localStorage.getItem('suiyin-reports') || '[]'); if(Array.isArray(saved)) history=saved.filter(r=>r&&Array.isArray(r.errors)&&typeof r.title==='string'&&r.waits&&Array.isArray(r.results)&&Number.isFinite(r.elapsed)).slice(0,30); } catch { /* 浏览器存储不可用时仍可练习。 */ }
let toastTimer;
function toast(message) { $('toast').textContent=message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').classList.remove('show'),4000); }
function duration(ms) { const seconds=Math.floor(ms/1000); return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`; }
function currentTime() { return state.elapsed + (state.status==='running' ? performance.now()-state.started : 0); }
function nextEvent() { return state.mode==='demo' ? state.score.events[state.demoIndex] : state.engine?.current || (state.engine?.done ? null : state.score.events[0]); }
async function ensureSound() {
  await audio.init();
  if(state.loadedInstrument===state.instrument.id) return;
  if(!state.soundPromise) {
    const instrument=state.instrument;
    $('audio-status').textContent='正在加载本地采样…';
    state.soundPromise=audio.load(instrument).then(ok=>{
      state.loadedInstrument=instrument.id;
      $('audio-status').textContent=ok?'本地采样音色已就绪':'合成音色 · 部分采样不可用';
      if(!ok) toast('部分采样未能加载，已启用合成音色，仍可正常弹奏。');
    }).catch(()=>{$('audio-status').textContent='合成音色';}).finally(()=>state.soundPromise=null);
  }
  await state.soundPromise;
  if(state.loadedInstrument!==state.instrument.id) return ensureSound();
}
function setPage(page) {
  if(['running','countdown','loading'].includes(state.status)) pause();
  allNotesOff();
  state.page=page;
  document.querySelectorAll('.page').forEach(el=>el.hidden=el.id!==`page-${page}`);
  document.querySelectorAll('[data-page]').forEach(el=>el.classList.toggle('active',el.dataset.page===page));
  $('breadcrumb').textContent={practice:'练习工作台',library:'我的曲谱',reports:'练习报告',guide:'使用指南'}[page];
  if(page==='reports') renderReports();
  if(page==='library') renderLibrary();
  if(page==='practice') render();
  window.scrollTo({top:0,behavior:'instant'});
}
function activeReport() {
  if(!state.engine || state.mode==='demo') return null;
  return {...state.engine.report(currentTime()),title:state.score.title,scoreId:state.score.id,instrument:state.instrument.name,date:new Date().toISOString(),measures:state.score.measures,loop:state.sessionLoop,id:state.sessionId};
}
function saveReport() {
  if(state.sessionSaved || !state.engine || state.mode==='demo') return;
  const report=activeReport();
  if(!report || (!report.judged && !report.errors.length && report.elapsed<1000)) return;
  history.unshift(report); history=history.slice(0,30); state.sessionSaved=true; state.selectedReport=0;
  try { localStorage.setItem('suiyin-reports',JSON.stringify(history)); } catch { toast('浏览器存储已满，报告保留在当前页面，可导出保存。'); }
}
function getLoop() {
  if(!$('loop-enabled').checked) return null;
  return [Number($('loop-start').value),Number($('loop-end').value)];
}
function validateSettings() {
  const bpm=Number($('tempo').value), loop=getLoop();
  if(!Number.isFinite(bpm)||bpm<30||bpm>200) { toast('速度需要在 30–200 BPM 之间。'); return false; }
  if(loop&&(!loop.every(Number.isInteger)||loop[0]<1||loop[1]>state.score.measures||loop[0]>loop[1])) { toast(`循环范围应在 1–${state.score.measures} 小节之间，且起点不大于终点。`); return false; }
  const pitches=state.score.events.filter(e=>!loop||(e.measure>=loop[0]&&e.measure<=loop[1])).flatMap(e=>e.pitches);
  if(pitches.some(p=>!targetsFor(p,state.instrument).length)) { toast('曲谱中的部分音符超出当前乐器界面音域，请更换乐器或导入合适音域的曲谱。'); return false; }
  return true;
}
function reset({save=true}={}) {
  if(save) { if(state.status==='running') { state.elapsed=currentTime(); state.status='paused'; } saveReport(); }
  cancelCountdown(); allNotesOff(); clearDemo(); backend.reset();
  state.engine=null; state.status='idle'; state.elapsed=0; state.sessionSaved=false; state.demoIndex=0; state.lastBeat=-1;
  state.errors.clear(); state.flashes.clear(); $('position-label').textContent='准备就绪'; render();
}
async function begin() {
  if(state.status==='running') { pause(); return; }
  if(state.status==='countdown') { cancelCountdown(); state.status='idle'; render(); return; }
  if(!validateSettings()) return;
  const token=++state.countToken;
  state.status='loading'; renderTransport();
  try { await ensureSound(); } catch { state.status='idle'; renderTransport(); toast('浏览器无法开启音频，请点击琴键重试。'); return; }
  if(token!==state.countToken) return;
  if(state.sessionSaved||state.engine?.done) reset({save:false});
  const resume=state.engine&&state.elapsed>0;
  if(!state.engine) {
    state.engine=new PracticeEngine(state.score,{mode:state.mode,bpm:Number($('tempo').value),tolerance:Number($('tolerance').value),chordWindow:Number($('chord-window').value),loop:getLoop()});
    state.sessionId=`practice-${Date.now()}`;
    state.sessionLoop=getLoop();
    if(state.mode!=='demo') backend.start(state.score, {mode:state.mode,bpm:Number($('tempo').value),tolerance:Number($('tolerance').value),chordWindow:Number($('chord-window').value),loop:getLoop()});
  }
  if(state.mode==='demo' || state.mode==='follow') {
    state.status='countdown'; renderTransport(); let count=3;
    const show=()=>{
      $('score-stage').querySelector('.countdown-overlay')?.remove();
      $('score-stage').insertAdjacentHTML('beforeend',`<div class="countdown-overlay"><strong>${count}</strong><span>${resume?'准备继续':'跟着预备拍，找到节奏'}</span></div>`);
      audio.click(count===3);
    };
    show();
    state.countTimer=setInterval(()=>{count--;if(count>0) show();else{clearInterval(state.countTimer);state.countTimer=null;$('score-stage').querySelector('.countdown-overlay')?.remove();run();}},60000/Number($('tempo').value));
  } else run();
}
function run() { state.status='running'; state.started=performance.now(); state.lastBeat=-1; $('position-label').textContent=state.mode==='demo'?'聆听示范':state.mode==='wait'?'弹对当前目标':'跟随演奏'; if(state.mode==='demo') scheduleDemo(); render(); }
function cancelCountdown() { state.countToken++; clearInterval(state.countTimer); state.countTimer=null; $('score-stage').querySelector('.countdown-overlay')?.remove(); }
function pause() {
  if(state.status==='countdown'||state.status==='loading') { cancelCountdown(); state.status=state.engine?'paused':'idle'; }
  else if(state.status==='running') { state.elapsed=currentTime(); state.status='paused'; }
  allNotesOff(); clearDemo(); render();
}
function finish(show=true) {
  if(!state.engine) { toast('先完成一次练习，再查看报告。'); return; }
  if(state.status==='running') {state.elapsed=currentTime();state.status='paused';}
  cancelCountdown(); allNotesOff(); clearDemo();
  if(state.mode==='demo') {state.status='done';render();toast('示范结束，切换等待或跟弹模式试一试。');return;}
  saveReport(); backend.finish(currentTime()); state.status='done'; render();
  if(show) setPage('reports');
}
function complete() {
  if(state.status!=='running') return;
  const loop=getLoop();
  if(loop) {
    state.elapsed=currentTime(); state.status='paused'; saveReport(); backend.finish(state.elapsed);
    toast(`第 ${loop[0]}–${loop[1]} 小节练习完成，开始下一轮。`);
    reset({save:false}); begin();
  } else { finish(false); toast('练习完成！本次报告已生成。'); }
}
function clearDemo() { for(const id of state.demoTimers) clearTimeout(id); state.demoTimers.clear(); audio.stop(); }
function later(fn, ms) { const id=setTimeout(()=>{state.demoTimers.delete(id);fn();},Math.max(0,ms)); state.demoTimers.add(id); }
function scheduleDemo() {
  const events=state.engine.events, origin=events[0]?.beat||0, unit=60000/Number($('tempo').value), elapsed=state.elapsed;
  events.forEach((e,i)=>{
    const due=(e.beat-origin)*unit, end=due+e.duration*unit;
    if(end<=elapsed) return;
    later(()=>{state.demoIndex=state.score.events.indexOf(e);e.pitches.forEach((p,j)=>{const id=`demo-${i}-${j}`;audio.on(id,p,state.instrument);state.active.set(id,p);later(()=>noteOff(id),Math.max(50,end-Math.max(due,elapsed)-30));});render();},Math.max(0,due-elapsed));
  });
  const last=events.at(-1);
  if(last) later(()=>finish(false),(last.beat-origin+last.duration)*unit-elapsed+50);
}
async function noteOn(id, pitch, velocity=.8) {
  if(state.active.has(id)||!Number.isFinite(pitch)) return;
  state.active.set(id,pitch);
  try { await ensureSound(); } catch { state.active.delete(id);toast('无法开启音频，请检查浏览器的声音权限。');return; }
  if(!state.active.has(id)) return;
  audio.on(id,pitch,state.instrument,velocity);
  const now=performance.now();
  if(state.status==='running'&&state.mode!=='demo') {
    backend.event('note_on',pitch,currentTime(),velocity,id.split('-')[0]);
    const result=state.engine.noteOn(pitch,currentTime());
    if(result.type==='correct') {state.flashes.set(pitch,now+220); if(result.complete) $('position-label').textContent='很好，继续保持';}
    else if(result.type!=='idle') {state.errors.set(pitch,now+650);$('position-label').textContent=`${errorNames[result.type]} · 试试 ${state.engine.current?.pitches.map(noteName).join(' + ')||''}`;}
    if(state.engine.done) complete();
  }
  window.dispatchEvent(new CustomEvent('suiyin:note',{detail:{id,type:'note_on',pitch,velocity,timestamp:Math.round(currentTime()),source:id.split('-')[0]}}));
  render();
}
function noteOff(id) {
  const pitch=state.active.get(id);
  state.active.delete(id); audio.off(id);
  if(pitch!==undefined) {
    if(state.engine && state.mode!=='demo') backend.event('note_off',pitch,currentTime(),0,id.split('-')[0]);
    window.dispatchEvent(new CustomEvent('suiyin:note',{detail:{id,type:'note_off',pitch,velocity:0,timestamp:Math.round(currentTime()),source:id.split('-')[0]}}));
  }
  paintInstrument();
}
function allNotesOff() { for(const id of [...state.active.keys()]) noteOff(id); audio.stop(); pointers.clear(); }

function renderTransport() {
  const running=state.status==='running', busy=state.status==='loading', counting=state.status==='countdown';
  $('start-label').textContent=busy?'加载声音…':counting?'取消预备':running?'暂停练习':state.status==='paused'?'继续练习':state.status==='done'?'再次练习':state.mode==='demo'?'开始示范':'开始练习';
  $('start').querySelector('[data-icon]').innerHTML=icon(running?'pause':'play');
  $('start').disabled=busy;
  const locked=!!state.engine&&state.status!=='idle'&&state.status!=='done';
  $('tempo').disabled=locked; $('instrument').disabled=locked; $('speed-reset').disabled=locked;
  document.querySelectorAll('.mode-button').forEach(el=>{el.classList.toggle('active',el.dataset.mode===state.mode);el.disabled=state.status==='loading';});
  $('session-indicator').textContent={idle:'未开始',loading:'加载中',running:state.mode==='demo'?'示范中':'进行中',paused:'已暂停',countdown:'预备中',done:'已结束'}[state.status];
}
function render() {
  renderTransport(); renderScore(); renderNext(); renderStats(); paintInstrument();
}
function loadScore(score) {
  reset(); state.score=score;
  $('song-title').textContent=score.title; $('song-subtitle').textContent=score.subtitle; $('song-difficulty').textContent=score.difficulty;
  $('song-key').textContent=score.id.startsWith('import')?'实音谱':'C 大调';
  $('song-meter').textContent=`${score.beats}/${score.beatType} 拍`; $('song-measures').textContent=`${score.measures} 小节`;
  $('tempo').value=score.bpm; $('loop-enabled').checked=false; $('loop-start').value=1; $('loop-end').value=Math.min(4,score.measures); $('loop-end').max=score.measures; $('loop-start').max=score.measures;
  $('score-origin').textContent=score.id.startsWith('import')?'用户导入曲谱':'公版旋律 · 自行编配';
  setPage('practice'); render();
}
function makeInstrument() {
  const instrument=state.instrument;
  $('instrument-title').textContent=instrument.id==='piano'?'指尖上的钢琴':'琴弦之间的旋律';
  if(instrument.target==='key') {
    const [low,high]=instrument.range;
    const whites=Array.from({length:high-low+1},(_,i)=>low+i).filter(p=>![1,3,6,8,10].includes(p%12));
    let whiteIndex=0;
    let html='<div class="piano" role="group" aria-label="可弹奏钢琴 C3 至 C6">';
    for(let pitch=low;pitch<=high;pitch++) {
      const black=[1,3,6,8,10].includes(pitch%12), binding=KEY_CODES[pitch-state.base];
      const style=black?` style="left:calc(${whiteIndex/whites.length*100}% - 1.375%)"`:'';
      html+=`<button class="piano-key ${black?'black-key':'white-key'}" data-pitch="${pitch}"${style} aria-label="弹奏 ${noteName(pitch)}${binding?'，键盘 '+keyLabel(binding):''}" title="${noteName(pitch)}${binding?' · '+keyLabel(binding):''}">${black?'':`<span>${pitch%12===0?noteName(pitch):''}</span>`}<span class="key-binding">${binding?escape(keyLabel(binding)):''}</span></button>`;
      if(!black) whiteIndex++;
    }
    $('instrument-surface').innerHTML=html+'</div>';
  } else {
    let html='<div class="fretboard" role="group" aria-label="标准调弦吉他指板，0 至 12 品"><div class="fret-labels"><span></span>'+Array.from({length:13},(_,i)=>`<span>${i===0?'空弦':i}</span>`).join('')+'</div>';
    instrument.tuning.forEach((open,i)=>{html+=`<div class="fret-row"><span class="string-label">${i+1}弦</span>`;for(let fret=0;fret<=12;fret++){const pitch=open+fret;html+=`<button class="fret" data-pitch="${pitch}" aria-label="${i+1}弦 ${fret}品 ${noteName(pitch)}" title="${i+1}弦 ${fret}品 · ${noteName(pitch)}"><span>${fret}</span></button>`;}html+='</div>';});
    $('instrument-surface').innerHTML=html+'</div>';
  }
  paintInstrument();
}
function paintInstrument() {
  const event=nextEvent(), expected=event?.pitches||[], active=[...state.active.values()];
  const events=state.engine?.events||state.score.events;
  const index=event?events.indexOf(event):-1;
  const preview=events.slice(index+1,index+1+state.preview).flatMap(e=>e.pitches);
  const now=performance.now();
  document.querySelectorAll('[data-pitch]').forEach(el=>{
    const pitch=Number(el.dataset.pitch);
    el.classList.toggle('expected',expected.includes(pitch)&&state.status!=='done');
    el.classList.toggle('preview',preview.includes(pitch)&&!expected.includes(pitch)&&state.status!=='done');
    el.classList.toggle('pressed',active.includes(pitch));
    el.classList.toggle('error',(state.errors.get(pitch)||0)>now);
    el.classList.toggle('correct-flash',(state.flashes.get(pitch)||0)>now);
    el.setAttribute('aria-pressed',String(active.includes(pitch)));
  });
}
function renderNext() {
  const event=nextEvent(), done=state.status==='done';
  const pitch=event?.pitches[0];
  $('next-status').textContent=done?'本轮结束':state.mode==='demo'?'正在示范':state.status==='running'?'轮到你了':'等待弹奏';
  if(done||pitch===undefined) {
    $('next-name').textContent=done?'✓':'𝄽'; $('next-solfege').textContent=done?'练习完成，休息一下':'休止，保持节奏';
    $('next-location').textContent=done?'查看报告，发现进步':'等待下一个目标音';
  } else {
    const name=noteName(pitch);
    $('next-name').innerHTML=`${escape(name.slice(0,-1))}<sub>${escape(name.slice(-1))}</sub>`;
    const solfege={0:'Do',2:'Re',4:'Mi',5:'Fa',7:'Sol',9:'La',11:'Si'}[pitch%12]||'变化音';
    $('next-solfege').textContent=event.pitches.length>1?event.pitches.map(noteName).join(' + '):pitch===60?'中央 Do':solfege;
    const binding=KEY_CODES[pitch-state.base];
    if(state.instrument.target==='fret') {
      const positions=targetsFor(pitch,state.instrument); $('next-location').textContent=positions.slice(0,2).map(p=>`${p.string}弦 ${p.fret}品`).join(' / ')||'超出指板音域';
    } else $('next-location').innerHTML=binding?`${icon('keyboard')}按下键盘 <kbd>${escape(keyLabel(binding))}</kbd>`:`点击琴键 ${escape(name)}`;
  }
  const events=state.engine?.events||state.score.events, index=event?events.indexOf(event):events.length;
  $('upcoming-notes').innerHTML=done?'<span class="notice-inline">每一遍练习，都离熟练更近。</span>':events.slice(index+1,index+1+state.preview).map(e=>`<div class="upcoming-note">${e.pitches.length?escape(noteName(e.pitches[0])):'休止'}<small>${e.pitches.length>1?'和弦':e.duration+' 拍'}</small></div>`).join('');
  $('mode-tip').textContent={wait:'不着急，弹对当前音符后，谱面才会继续前进。',follow:'跟着节拍弹奏。橙色目标会随演奏推进，留意即将到来的音。',demo:'先听一遍，熟悉旋律。示范播放不会计入练习报告。'}[state.mode];
}
function renderStats() {
  const report=state.engine?.report(currentTime()), demo=state.mode==='demo';
  $('session-time').innerHTML=`${duration(currentTime())}<small>${demo?'示范时长':'练习时长'}</small>`;
  $('accuracy').innerHTML=`${report?.accuracy!=null&&!demo?report.accuracy:'—'}<small>%</small>`;
  $('error-count').innerHTML=`${demo?0:report?.errors.length||0}<small>次</small>`;
  const progress=demo?Math.round(state.demoIndex/state.score.events.length*100):report?.completion||0;
  $('progress-value').textContent=`${state.status==='done'&&demo?100:progress}%`; $('progress-fill').style.width=`${state.status==='done'&&demo?100:progress}%`;
  const event=nextEvent();
  $('measure-label').textContent=`第 ${event?.measure||state.score.measures} / ${state.score.measures} 小节`;
}
function noteY(pitch,bottom) {
  const pc=pitch%12, step={0:0,1:0,2:1,3:1,4:2,5:3,6:3,7:4,8:4,9:5,10:5,11:6}[pc];
  return bottom-((Math.floor(pitch/12)-5)*7+step-2)*4;
}
function renderScore() {
  if(state.page!=='practice') return;
  const width=Math.max(300,$('score-stage').clientWidth-24), height=190;
  const event=nextEvent(), current=event?.id;
  const resultMap=new Map((state.engine?.results||[]).map(r=>[r.eventId,r]));
  const errors=new Set((state.engine?.errors||[]).map(e=>e.eventId));
  const source=state.engine?.events||state.score.events;
  const index=event?source.indexOf(event):0;
  const upcoming=new Set(source.slice(index+1,index+1+state.preview).map(e=>e.id));
  const currentMeasure=event?.measure||state.score.measures;
  let svg=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(state.score.title)}，当前第 ${currentMeasure} 小节">`;
  if(state.view==='roll') {
    const origin=event?.beat||0, visible=state.score.events.filter(e=>e.beat>=origin-2&&e.beat<origin+10);
    const low=48, high=84, lane=width/(high-low+1);
    for(let p=low;p<=high;p++) svg+=`<rect x="${(p-low)*lane}" y="5" width="${lane}" height="165" fill="${[1,3,6,8,10].includes(p%12)?'#f1f3ec':'#fafbf7'}" stroke="#e9eddf" stroke-width=".5"/>`;
    for(let b=-2;b<10;b++) {const y=153-b*15;svg+=`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#e3e8d9" stroke-dasharray="3 4"/>`;}
    visible.forEach(e=>{e.pitches.forEach(p=>{
      const fill=errors.has(e.id)?'#d88b7c':e.id===current?'#e49b6c':resultMap.has(e.id)?'#98b38b':'#d7e1ca';
      svg+=`<rect x="${(p-low)*lane+1}" y="${153-(e.beat-origin+e.duration)*15}" width="${Math.max(2,lane-2)}" height="${Math.max(4,e.duration*15-3)}" rx="3" fill="${fill}"/>`;
    });});
    svg+=`<line x1="0" y1="153" x2="${width}" y2="153" stroke="#d8804f" stroke-width="2"/><text x="${width-6}" y="184" text-anchor="end" class="roll-label">提前 10 拍 · 橙线为待奏位置</text>`;
    for(let p=48;p<=84;p+=12) svg+=`<text x="${(p-low)*lane+2}" y="181" class="roll-label">${noteName(p)}</text>`;
  } else {
    const columns=width>540?2:1, perPage=columns*2, pageStart=Math.floor((currentMeasure-1)/perPage)*perPage+1;
    for(let row=0;row<2;row++) {
      const top=27+row*88, bottom=top+32, clefWidth=45;
      for(let line=0;line<5;line++) svg+=`<line x1="13" y1="${top+line*8}" x2="${width-10}" y2="${top+line*8}" stroke="#d7dfcd" stroke-width=".8"/>`;
      svg+=`<text x="12" y="${bottom+5}" font-family="Georgia,serif" font-size="43" fill="#65795a">𝄞</text><text x="37" y="${top+13}" font-size="11" fill="#87977a" font-family="Georgia">${state.score.beats}</text><text x="37" y="${top+29}" font-size="11" fill="#87977a" font-family="Georgia">${state.score.beatType}</text>`;
      for(let col=0;col<columns;col++) {
        const measure=pageStart+row*columns+col;
        if(measure>state.score.measures) continue;
        const start=clefWidth+col*(width-clefWidth-12)/columns, barWidth=(width-clefWidth-12)/columns;
        svg+=`<text x="${start+7}" y="${top-10}" font-size="8" fill="#acb69c">${String(measure).padStart(2,'0')}</text><line x1="${start+barWidth}" y1="${top}" x2="${start+barWidth}" y2="${bottom}" stroke="#cfd8c3"/>`;
        const notes=state.score.events.filter(e=>e.measure===measure);
        const firstBeat=notes[0]?.beat||0;
        const span=Math.max(state.score.beats*4/state.score.beatType,...notes.map(e=>e.beat-firstBeat+e.duration));
        notes.forEach(e=>{
          const x=start+18+(e.beat-firstBeat)/span*(barWidth-30);
          let fill='#64775a';
          if(errors.has(e.id)) fill='#cc8372';
          else if(resultMap.has(e.id)) fill='#9ab38a';
          else if(e.id===current&&state.status!=='done') fill='#d97949';
          else if(upcoming.has(e.id)) fill='#d6b896';
          if(e.id===current&&state.status!=='done') svg+=`<rect x="${x-12}" y="${top-7}" width="25" height="61" rx="5" fill="#fcf0e3"/><line x1="${x}" y1="${top-7}" x2="${x}" y2="${bottom+23}" stroke="#d99a6c" stroke-dasharray="2 3" stroke-width=".6"/>`;
          if(!e.pitches.length) {svg+=`<text x="${x-5}" y="${top+25}" font-size="24" fill="${fill}" font-family="serif">𝄽</text>`;return;}
          e.pitches.forEach(p=>{
            const y=noteY(p,bottom), open=e.duration>=2;
            for(let ledger=bottom+8;ledger<=y+1;ledger+=8) svg+=`<line x1="${x-8}" y1="${ledger}" x2="${x+9}" y2="${ledger}" stroke="${fill}" stroke-width=".8"/>`;
            for(let ledger=top-8;ledger>=y-1;ledger-=8) svg+=`<line x1="${x-8}" y1="${ledger}" x2="${x+9}" y2="${ledger}" stroke="${fill}" stroke-width=".8"/>`;
            if([1,3,6,8,10].includes(p%12)) svg+=`<text x="${x-14}" y="${y+4}" font-size="13" fill="${fill}">♯</text>`;
            svg+=`<ellipse class="score-note" cx="${x}" cy="${y}" rx="5.2" ry="3.7" transform="rotate(-18 ${x} ${y})" fill="${open?'#fff':fill}" stroke="${fill}" stroke-width="1.2"/>`;
            if(e.duration<4) svg+=`<line x1="${x+4.5}" y1="${y-1}" x2="${x+4.5}" y2="${y-26}" stroke="${fill}" stroke-width="1.1"/>`;
            if(e.duration<1) svg+=`<path d="M${x+4.5} ${y-26}q14 6 4 17" fill="none" stroke="${fill}" stroke-width="1.5"/>`;
            if(e.duration===1.5||e.duration===3) svg+=`<circle cx="${x+10}" cy="${y-2}" r="1.5" fill="${fill}"/>`;
          });
          if(errors.has(e.id)) svg+=`<circle cx="${x}" cy="${bottom+28}" r="2" fill="#ca8974"/>`;
        });
      }
    }
  }
  $('score-content').innerHTML=svg+'</svg>';
}

function renderLibrary() {
  $('library-grid').innerHTML=SCORES.map((score,i)=>`<article class="card library-card"><div class="library-art" aria-hidden="true"><span>${['♫','𝄞','♩','♬'][i%4]}</span></div><div><span class="pill green">${escape(score.difficulty)}</span></div><h2>${escape(score.title)}</h2><small>${escape(score.subtitle)}</small><p>${escape(score.description)}</p><div class="library-meta"><span>${score.measures} 小节</span><span>${score.bpm} BPM</span><span>${score.beats}/${score.beatType} 拍</span></div><button class="button secondary" data-score="${escape(score.id)}">开始练习 <span>→</span></button></article>`).join('');
  $('library-grid').querySelectorAll('[data-score]').forEach(button=>button.onclick=()=>loadScore(SCORES.find(s=>s.id===button.dataset.score)));
  document.querySelector('.nav-count').textContent=SCORES.length;
}
function reportList() {
  const live=activeReport();
  return live&&!state.sessionSaved&&(live.judged||live.errors.length||live.elapsed>=1000)?[{...live,live:true},...history]:history;
}
function renderReports() {
  const reports=reportList(); state.selectedReport=Math.min(state.selectedReport,Math.max(0,reports.length-1));
  const report=reports[state.selectedReport]; $('export-report').disabled=!report;
  if(!report) {
    $('report-content').innerHTML=`<div class="card report-empty"><div class="empty-symbol">♩</div><h2>第一份进步记录，等你来写。</h2><p>完成或结束一次练习，就能看到正确率、错误明细和小节分析。</p><button class="button primary" id="empty-practice">去练习第一首曲子</button></div>`;
    $('empty-practice').onclick=()=>setPage('practice');return;
  }
  const counts={}; report.errors.forEach(e=>counts[e.measure]=(counts[e.measure]||0)+1);
  const max=Math.max(1,...Object.values(counts));
  const worst=Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
  const stalled=Object.entries(report.waits||{}).sort((a,b)=>b[1]-a[1])[0];
  $('report-content').innerHTML=`<div class="report-top"><div><h2>${escape(report.title)} <span class="pill green">${report.live?'当前练习快照':'练习记录'}</span></h2><p>${new Date(report.date).toLocaleString('zh-CN',{hour12:false})} · ${escape(report.instrument)} · ${modeNames[report.mode]||'练习'} · ${report.bpm} BPM${report.loop?' · 第 '+report.loop.join('–')+' 小节循环':''}</p></div><select id="history-select" aria-label="选择练习记录">${reports.map((r,i)=>`<option value="${i}" ${i===state.selectedReport?'selected':''}>${i===0?'最近 · ':''}${escape(r.title)} · ${new Date(r.date).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</option>`).join('')}</select></div>
  <div class="report-metrics"><div class="card report-metric"><span>正确率</span><strong>${report.accuracy??'—'}<small>%</small></strong><p>包含错误输入与已判定的漏音</p></div><div class="card report-metric"><span>有效练习时长</span><strong>${duration(report.elapsed)}</strong><p>不计预备拍与暂停时间</p></div><div class="card report-metric"><span>错误记录</span><strong>${report.errors.length}<small>次</small></strong><p>错音 ${report.errors.filter(e=>e.type==='wrong').length} · 漏音 ${report.errors.filter(e=>e.type==='missed').length} · 多音 ${report.errors.filter(e=>e.type==='extra').length}</p></div><div class="card report-metric"><span>练习完成度</span><strong>${report.completion}<small>%</small></strong><p>已判定 ${report.judged} / ${report.total} 个目标音</p></div></div>
  <div class="report-detail-grid"><section class="card report-detail"><h3>每个小节，都值得再听一遍</h3><div class="measure-chart">${Array.from({length:Math.min(report.measures,200)},(_,i)=>{const n=counts[i+1]||0;return `<div class="measure-bar ${n?'has-error':''}" style="height:${Math.max(6,n/max*92)}px" title="第 ${i+1} 小节，${n} 条错误"><span>${n||''}</span><small>${i+1}</small></div>`;}).join('')}</div><p class="report-hint">${worst?`第 ${worst[0]} 小节出现 ${worst[1]} 条错误，建议降低速度，单独练习。`:'当前没有错误记录，继续保持。'}${stalled&&stalled[1]>=1000?`<br>等待模式停留超出参考时值最多：第 ${stalled[0]} 小节，约 ${(stalled[1]/1000).toFixed(1)} 秒。`:''}</p><p class="report-hint">${report.completion<100?'本次提前结束；未到达的目标不计为漏音。':'本轮目标已全部判定。'}${report.measures>200?' 图表显示前 200 小节，完整记录可导出。':''}</p></section><section class="card report-detail"><h3>错在哪里，下次就练哪里</h3>${report.errors.length?`<div class="table-scroll"><table class="error-table"><thead><tr><th>小节</th><th>类型</th><th>目标</th><th>实际</th><th>时间</th></tr></thead><tbody>${report.errors.map(e=>`<tr><td>第 ${e.measure}</td><td><span class="error-tag">${errorNames[e.type]||escape(e.type)}</span></td><td>${escape(Array.isArray(e.expected)?e.expected.map(noteName).join(' / '):e.expected==null?'—':noteName(e.expected))}</td><td>${e.pitch==null?'未弹':escape(noteName(e.pitch))}</td><td>${duration(e.time)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="no-errors">✦ 暂无错误记录，每一个音都在进步。</div>'}</section></div><p class="history-note">记录仅保存在当前浏览器，最多保留 30 次练习。暂停期间可查看当前快照；示范模式不生成报告。</p>`;
  $('history-select').onchange=e=>{state.selectedReport=Number(e.target.value);renderReports();};
}
function exportReport() {
  const report=reportList()[state.selectedReport]; if(!report) return;
  const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json;charset=utf-8'}), url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=`随音-${report.title.replace(/[<>:"/\\|?*]/g,'_')}-练习报告.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('练习报告已导出为 JSON。');
}

const pointers=new Map();
const surface=$('instrument-surface');
surface.addEventListener('pointerdown',e=>{
  const button=e.target.closest('[data-pitch]'); if(!button || (e.pointerType==='mouse'&&e.button!==0)) return;
  e.preventDefault();const id=`pointer-${e.pointerId}`;pointers.set(e.pointerId,Number(button.dataset.pitch));surface.setPointerCapture(e.pointerId);noteOn(id,Number(button.dataset.pitch));
});
surface.addEventListener('pointermove',e=>{
  if(!pointers.has(e.pointerId)) return;
  const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-pitch]');
  const pitch=target&&surface.contains(target)?Number(target.dataset.pitch):null;
  if(pitch===pointers.get(e.pointerId)) return;
  noteOff(`pointer-${e.pointerId}`);pointers.set(e.pointerId,pitch);
  if(pitch!=null) noteOn(`pointer-${e.pointerId}`,pitch);
});
function releasePointer(e){if(pointers.has(e.pointerId)){noteOff(`pointer-${e.pointerId}`);pointers.delete(e.pointerId);}}
surface.addEventListener('pointerup',releasePointer);surface.addEventListener('pointercancel',releasePointer);surface.addEventListener('lostpointercapture',releasePointer);
surface.addEventListener('click',e=>{
  // 键盘/辅助技术触发 button.click 时，无 pointerdown，仍然可以演奏。
  if(e.detail!==0) return;const button=e.target.closest('[data-pitch]');if(!button)return;
  const id=`accessible-${button.dataset.pitch}`;noteOn(id,Number(button.dataset.pitch));setTimeout(()=>noteOff(id),350);
});
document.addEventListener('keydown',e=>{
  if(state.page!=='practice'||$('settings-dialog').open||e.ctrlKey||e.metaKey||e.altKey||/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if(e.code==='Space'){if(e.target.tagName==='BUTTON')return;e.preventDefault();if(!e.repeat)begin();return;}
  const index=KEY_CODES.indexOf(e.code);if(index<0)return;e.preventDefault();if(!e.repeat)noteOn(`keyboard-${e.code}`,state.base+index);
});
document.addEventListener('keyup',e=>noteOff(`keyboard-${e.code}`));
window.addEventListener('blur',()=>{if(state.status==='running'||state.status==='countdown')pause();else allNotesOff();});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&(state.status==='running'||state.status==='countdown'))pause();});

let midiAccess=null;
async function connectMIDI() {
  if(!navigator.requestMIDIAccess){toast('当前浏览器不支持 Web MIDI，请在支持的 Chrome / Edge 安全上下文中使用。');return;}
  try {
    await ensureSound();midiAccess=await navigator.requestMIDIAccess({sysex:false});
    const bind=()=>{
      allNotesOff();const inputs=[...midiAccess.inputs.values()];
      $('input-source').textContent=inputs.length?`MIDI · ${inputs[0].name||'已连接'}`:'网页乐器已连接';
      $('connect-midi').innerHTML=icon('plug')+(inputs.length?'刷新 MIDI 连接':'连接 MIDI 设备');
      inputs.forEach(input=>input.onmidimessage=message=>{
        const [status,pitch,velocity]=message.data, command=status&0xf0, channel=status&0x0f, id=`midi-${input.id}-${channel}-${pitch}`;
        if(command===0x90&&velocity>0&&state.page==='practice'&&!$('settings-dialog').open)noteOn(id,pitch,velocity/127);
        else if(command===0x80||(command===0x90&&velocity===0))noteOff(id);
      });
    };
    midiAccess.onstatechange=bind;bind();toast(midiAccess.inputs.size?'MIDI 已连接，与网页乐器共用演奏事件接口。':'权限已开启，未检测到 MIDI 设备；插入设备后会自动连接。');
  }catch(error){toast(error.name==='NotAllowedError'?'MIDI 权限未获允许，仍可使用网页琴键和电脑键盘。':'MIDI 连接失败，请检查设备连接和浏览器权限。');}
}
async function importScore(file) {
  if(!file)return;
  if(file.size>2_000_000){toast('请导入小于 2 MB 的 MusicXML 文件。');return;}
  try {const score=parseMusicXML(await file.text());SCORES.push(score);renderLibrary();loadScore(score);toast(`已导入「${score.title}」，共 ${score.measures} 小节。`);}catch(error){toast(error.message);}
  finally{$('file-input').value='';}
}
document.querySelectorAll('[data-page]').forEach(button=>button.onclick=()=>setPage(button.dataset.page));
document.querySelector('.brand').onclick=e=>{e.preventDefault();setPage('practice');};
$('help-button').onclick=()=>setPage('guide');
let settingsSnapshot=null;
function openSettings(){if(['running','countdown','loading'].includes(state.status))pause();settingsSnapshot=['tolerance','chord-window','loop-start','loop-end'].map(id=>[id,$(id).value]);settingsSnapshot.push(['loop-enabled',$('loop-enabled').checked]);$('settings-dialog').showModal();}
$('settings-nav').onclick=$('mode-help').onclick=openSettings;
$('settings-dialog').addEventListener('close',()=>{if($('settings-dialog').returnValue==='save'){if(validateSettings()){reset();toast('设置已保存，下一轮练习将采用新设置。');}else $('settings-dialog').showModal();}else if(settingsSnapshot){for(const [id,value] of settingsSnapshot){if(id==='loop-enabled')$(id).checked=value;else $(id).value=value;}}});
$('settings-dialog').addEventListener('click',e=>{if(e.target===$('settings-dialog')){const rect=e.target.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)e.target.close('cancel');}});
document.querySelectorAll('.mode-button').forEach(button=>button.onclick=()=>{if(button.dataset.mode===state.mode)return;reset();state.mode=button.dataset.mode;$('position-label').textContent='准备就绪';render();});
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{state.view=button.dataset.view;document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b===button));renderScore();});
$('start').onclick=begin;$('restart').onclick=()=>{reset();toast('已回到起点，准备好后再开始。');};$('finish').onclick=()=>finish();
$('change-song').onclick=()=>setPage('library');$('import-button').onclick=$('library-import').onclick=()=>$('file-input').click();$('file-input').onchange=e=>importScore(e.target.files[0]);
$('instrument').onchange=()=>{reset();state.instrument=INSTRUMENTS[$('instrument').value];state.loadedInstrument=null;makeInstrument();render();ensureSound().catch(()=>toast('请点击乐器开启声音。'));};
$('octave').onchange=()=>{allNotesOff();state.base=Number($('octave').value);makeInstrument();renderNext();};
$('volume').oninput=()=>audio.setVolume(Number($('volume').value)/100);
$('preview-count').onchange=()=>{state.preview=Number($('preview-count').value);render();};
$('tempo').onchange=()=>{const bpm=Number($('tempo').value);if(bpm<30||bpm>200||!Number.isFinite(bpm)){$('tempo').value=state.score.bpm;toast('速度已恢复为原速，请输入 30–200 BPM。');}};
$('speed-reset').onclick=()=>{$('tempo').value=state.score.bpm;toast('已恢复曲谱原速。');};
$('connect-midi').onclick=connectMIDI;
$('session-report').onclick=()=>{if(state.status==='running'||state.status==='countdown')pause();state.selectedReport=0;setPage('reports');};
$('export-report').onclick=exportReport;
$('model-file').onchange=() => { $('model-output').textContent=$('model-file').files[0]?.name || '尚未选择音频'; };
$('model-transcribe').onclick=async () => {
  const file=$('model-file').files[0];
  if(!file) { toast('请先选择 WAV 音频文件。'); return; }
  if(file.size>5*1024*1024) { toast('WAV 文件不得超过 5 MiB。'); return; }
  const button=$('model-transcribe'), output=$('model-output');
  button.disabled=true; output.textContent='正在调用 Basic Pitch 音频转录服务…';
  try {
    const response=await fetch('/api/transcriptions',{method:'POST',headers:{'Content-Type':'audio/wav'},body:file,signal:AbortSignal.timeout(90000)});
    const data=await response.json();
    if(!response.ok) throw new Error(data.message || '模型服务暂不可用');
    const excerpt=data.notes.slice(0,24).map(n=>`${(n.startMs/1000).toFixed(2)}s · ${noteName(n.pitch)}`).join('、');
    output.textContent=`模型：${data.model}\n识别音符 ${data.noteCount} 个 · 推理 ${data.inferenceMs} ms · 完整 HTTP 往返 ${data.roundTripMs} ms\n${excerpt}${data.noteCount>24?' …':''}`;
    // 同一份规范化曲谱可直接用于批量匹配；识别结果不回写原练习报告。
    const match=await fetch('/api/match',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({score:state.score,options:{mode:'follow',bpm:Number($('tempo').value)},notes:data.notes.map(n=>({pitch:n.pitch,startMs:n.startMs})),endMs:Math.max(0,...data.notes.map(n=>n.endMs))})});
    if(match.ok){const compared=await match.json();output.textContent+=`\n当前曲谱对齐：${compared.report.correct}/${compared.report.total} 个目标音正确，${compared.report.errors.length} 条错误（离线粗对齐）`;} 
  }catch(error){output.textContent=`模型不可用：${error.message}\n按键练习无需启动音频模型，仍能正常使用。`;}finally{button.disabled=false;}
};
new ResizeObserver(()=>renderScore()).observe($('score-stage'));
function frame(now) {
  if(state.status==='running') {
    const time=currentTime();
    if(state.mode!=='demo'){
      backend.tick(time);
      const oldIndex=state.engine.index,oldErrors=state.engine.errors.length;state.engine.tick(time);
      if(state.engine.done)complete();
      else if(oldIndex!==state.engine.index||oldErrors!==state.engine.errors.length){$('position-label').textContent='漏音已记录，跟上下一音';render();}
    }
    const beat=Math.floor(time/(60000/Number($('tempo').value)*4/state.score.beatType));
    if(beat!==state.lastBeat){if($('metronome').checked)audio.click(beat%state.score.beats===0);state.lastBeat=beat;}
  }
  if(now-state.lastUI>140){
    state.lastUI=now;
    if(state.page==='practice'){renderStats();paintInstrument();}
  }
  requestAnimationFrame(frame);
}
makeInstrument();renderLibrary();loadScore(SCORES[0]);requestAnimationFrame(frame);
