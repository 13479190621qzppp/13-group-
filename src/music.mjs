export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const noteName = midi => `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
export const KEY_CODES = ['KeyA','KeyW','KeyS','KeyE','KeyD','KeyF','KeyT','KeyG','KeyY','KeyH','KeyU','KeyJ','KeyK','KeyO','KeyL','KeyP','Semicolon','Quote'];
export const keyLabel = code => ({ Semicolon:';', Quote:"'" }[code] || code.replace('Key', ''));
export const INSTRUMENTS = {
  piano: { id:'piano', name:'原声钢琴', subtitle:'PIANO', target:'key', range:[48,84], polyphonic:true, tuning:null, samples:[48,60,64,67,72], description:'键盘乐器 · 高亮目标琴键' },
  guitar: { id:'guitar', name:'尼龙弦吉他', subtitle:'GUITAR', target:'fret', range:[40,76], polyphonic:true, tuning:[64,59,55,50,45,40], frets:12, samples:[52,55,61,64,73], description:'弦乐器 · 提示琴弦与品位' }
};
export function targetsFor(pitch, instrument) {
  if (instrument.target === 'key') return pitch >= instrument.range[0] && pitch <= instrument.range[1] ? [{ pitch, key:pitch }] : [];
  return instrument.tuning.flatMap((open, i) => pitch >= open && pitch <= open + instrument.frets ? [{ pitch, string:i + 1, fret:pitch - open }] : []);
}
export function makeScore(id, title, subtitle, sequence, { bpm = 80, beats = 4, difficulty = '入门', description = '', attribution = '传统旋律 / 公版作品；本项目自行编配' } = {}) {
  let beat = 0;
  const events = sequence.map((item, i) => {
    const pitches = Array.isArray(item[0]) ? item[0] : item[0] === null ? [] : [item[0]];
    const event = { id:`${id}-${i}`, pitches, duration:item[1], beat, measure:Math.floor(beat / beats) + 1 };
    beat += item[1];
    return event;
  });
  return { id, title, subtitle, events, bpm, beats, beatType:4, measures:Math.ceil(beat / beats), difficulty, description, attribution, totalBeats:beat };
}
const melody = (notes, durations) => notes.map((n, i) => [n, durations?.[i] || 1]);
export const SCORES = [
  makeScore('twinkle', '小星星', 'Twinkle, Twinkle, Little Star', melody([60,60,67,67,69,69,67,65,65,64,64,62,62,60,67,67,65,65,64,64,62,67,67,65,65,64,64,62,60,60,67,67,69,69,67,65,65,64,64,62,62,60], Array.from({length:42}, (_,i)=>i%7===6?2:1)), {description:'从熟悉的旋律开始，让指尖找到节奏。',bpm:80}),
  makeScore('joy', '欢乐颂', 'Ode to Joy · Ludwig van Beethoven', melody([64,64,65,67,67,65,64,62,60,60,62,64,64,62,62,64,64,65,67,67,65,64,62,60,60,62,64,62,60,60], [1,1,1,1,1,1,1,1,1,1,1,1,1.5,.5,2,1,1,1,1,1,1,1,1,1,1,1,1,1.5,.5,2]), {description:'用平稳的节奏，练习相邻音之间的转换。',bpm:96}),
  makeScore('scale', 'C 大调音阶', 'C Major · Finger Warm-up', melody([60,62,64,65,67,69,71,72,72,71,69,67,65,64,62,60]), {description:'上下行音阶，熟悉一个八度的键位。',bpm:72}),
  makeScore('chords', '和弦小练习', 'C · F · G · C', [[[60,64,67],4],[[60,65,69],4],[[59,62,67],4],[[60,64,67],4]], {description:'在 160 ms 内按齐三个音，练习和弦的整齐度。',bpm:60,difficulty:'进阶'}),
];

export function parseMusicXML(text) {
  if (text.length > 2_000_000) throw new Error('曲谱过大，请使用小于 2 MB 的 MusicXML。');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('文件不是有效的 XML，请检查曲谱文件。');
  if (doc.documentElement.localName !== 'score-partwise') throw new Error('目前支持未压缩的 score-partwise MusicXML（.xml / .musicxml），暂不支持 .mxl 或 Guitar Pro。');
  const part = doc.querySelector('part');
  if (!part) throw new Error('曲谱中没有可读取的声部。');
  if (part.querySelector('transpose')) throw new Error('暂不支持移调乐器谱，请先导出实音谱。');
  if (part.querySelector('repeat')) throw new Error('暂不展开反复记号，请先导出展开反复后的 MusicXML。');
  const val = (el, selector, fallback) => el.querySelector(selector)?.textContent?.trim() ?? fallback;
  let divisions = 1, beats = 4, beatType = 4, beat = 0, bpm = 80;
  let firstBeats = null, firstBeatType = null;
  const events = [], measures = [...part.children].filter(e=>e.localName==='measure');
  const ties = new Map();
  measures.forEach((measure, mi) => {
    divisions = Number(val(measure, 'attributes > divisions', divisions));
    beats = Number(val(measure, 'attributes > time > beats', beats));
    beatType = Number(val(measure, 'attributes > time > beat-type', beatType));
    if (!(divisions > 0 && beats > 0 && beatType > 0)) throw new Error('曲谱的拍号或 divisions 无效。');
    firstBeats ??= beats; firstBeatType ??= beatType;
    if (beats !== firstBeats || beatType !== firstBeatType) throw new Error('当前版本暂不支持中途变拍号，请分段导入。');
    if (measure.querySelector('backup') || new Set([...measure.querySelectorAll('voice')].map(v=>v.textContent)).size > 1) throw new Error('当前导入支持第一乐器的单声部与同起点和弦，请先导出单声部练习谱。');
    const sound = measure.querySelector('sound[tempo]');
    if (mi === 0 && sound) bpm = Number(sound.getAttribute('tempo')) || 80;
    let cursor = beat, last = null, lastOnset = beat, maxEnd = beat;
    for (const el of measure.children) {
      if (el.localName === 'forward') { cursor += Number(val(el,'duration',0)) / divisions; maxEnd = Math.max(maxEnd,cursor); continue; }
      if (el.localName !== 'note' || el.querySelector('grace')) continue;
      const duration = Number(val(el,'duration',0)) / divisions;
      if (!(duration > 0)) throw new Error('存在缺少有效时值的音符。');
      const chord = !!el.querySelector('chord');
      const onset = chord ? lastOnset : cursor;
      if (!chord) lastOnset = onset;
      if (chord && last && Math.abs(last.duration-duration)>.0001) throw new Error('当前版本暂不支持同组不同时值的和弦，请先拆分为等时值练习谱。');
      if (el.querySelector('rest')) {
        events.push({ id:`xml-${events.length}`, pitches:[], beat:onset, duration, measure:mi+1 });
        if (!chord) cursor += duration;
        maxEnd = Math.max(maxEnd,cursor); last = events.at(-1); continue;
      }
      const step = val(el,'pitch > step','');
      const oct = Number(val(el,'pitch > octave','NaN'));
      const alter = Number(val(el,'pitch > alter',0));
      const pc = {C:0,D:2,E:4,F:5,G:7,A:9,B:11}[step];
      const pitch = (oct+1)*12+pc+alter;
      if (!Number.isInteger(pitch) || pitch<0 || pitch>127) throw new Error('曲谱含不支持的音高或微分音。');
      const stop = !!el.querySelector('tie[type="stop"]');
      const start = !!el.querySelector('tie[type="start"]');
      const previous = ties.get(pitch);
      if (stop && previous) {
        // 连音线延长原目标；不产生额外待奏音。
        previous.duration = Math.max(previous.duration, onset+duration-previous.beat);
        if (!start) ties.delete(pitch);
      } else {
        let event;
        if (chord && last && last.beat === onset && Math.abs(last.duration-duration)<.0001) { last.pitches.push(pitch); event = last; }
        else { event = {id:`xml-${events.length}`,pitches:[pitch],beat:onset,duration,measure:mi+1}; events.push(event); }
        last = event;
        if (start) ties.set(pitch,event);
      }
      if (!chord) cursor += duration;
      maxEnd = Math.max(maxEnd,onset+duration,cursor);
    }
    const measureEnd = Math.max(maxEnd, beat + (measure.getAttribute('implicit') === 'yes' ? maxEnd-beat : beats*4/beatType));
    if (cursor < measureEnd) events.push({id:`xml-rest-${mi}`,pitches:[],beat:cursor,duration:measureEnd-cursor,measure:mi+1});
    beat = measureEnd;
  });
  if (!events.some(e=>e.pitches.length)) throw new Error('这份曲谱没有可弹奏的音符。');
  if (events.length > 3000) throw new Error('请使用不超过 3000 个音符组的练习片段。');
  events.sort((a,b)=>a.beat-b.beat);
  return {id:`import-${Date.now()}`,title:val(doc,'work-title',val(doc,'movement-title','导入的练习曲')).slice(0,100),subtitle:'MusicXML · 第一乐器 / 单声部',events,bpm:Math.max(30,Math.min(200,bpm)),beats:firstBeats,beatType:firstBeatType,measures:measures.length,totalBeats:beat,difficulty:'自选',description:'从自己的曲谱开始练习。',attribution:'用户导入曲谱，请自行确认使用授权'};
}
