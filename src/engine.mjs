// 与界面、输入设备和网络无关的跟随内核。时间单位统一为练习开始后的毫秒。
export class PracticeEngine {
  constructor(score, { mode = 'wait', bpm = 80, tolerance = 250, chordWindow = 160, loop = null } = {}) {
    this.score = score;
    this.mode = mode;
    this.bpm = bpm;
    this.tolerance = tolerance;
    this.chordWindow = chordWindow;
    this.events = score.events.filter(e => !loop || (e.measure >= loop[0] && e.measure <= loop[1]));
    this.index = 0;
    this.results = [];
    this.errors = [];
    this.matched = new Set();
    this.chordStart = null;
    this.entryTime = 0;
    this.done = this.events.length === 0;
    this.recentCompleted = null;
    this.originBeat = this.events[0]?.beat || 0;
    this.offset = 0;
    this.waits = {};
  }
  get current() { return this.events[this.index]; }
  due(event = this.current) { return (event.beat - this.originBeat) * 60000 / this.bpm + this.offset; }
  record(type, event, time, pitch = null, expected = null) {
    const error = { type, eventId: event.id, measure: event.measure, pitch, expected, time: Math.round(time), delta: Math.round(time - this.due(event)) };
    this.errors.push(error);
    return error;
  }
  advance(time, correct = false) {
    const e = this.current;
    if (!e) return;
    if (e.pitches.length) {
      this.results.push({ eventId: e.id, measure: e.measure, expected: e.pitches.length, correct: this.matched.size, complete: correct, time: Math.round(time) });
      if (this.mode === 'wait') this.waits[e.measure] = (this.waits[e.measure] || 0) + Math.max(0, time - this.entryTime - e.duration * 60000 / this.bpm);
      if (correct) this.recentCompleted = { event:e, time };
    }
    this.index++;
    this.entryTime = time;
    this.matched.clear();
    this.chordStart = null;
    this.done = this.index >= this.events.length;
  }
  tick(time) {
    if (this.done) return;
    while (this.current) {
      const e = this.current;
      if (!e.pitches.length) {
        const end = this.mode === 'wait' ? this.entryTime + e.duration * 60000 / this.bpm : this.due(e) + e.duration * 60000 / this.bpm;
        if (time < end) break;
        this.advance(end);
        continue;
      }
      if (this.mode === 'wait' || time <= this.due(e) + this.tolerance) break;
      for (const pitch of e.pitches) if (!this.matched.has(pitch)) this.record('missed', e, time, null, pitch);
      this.advance(time);
    }
  }
  noteOn(pitch, time) {
    this.tick(time);
    const e = this.current;
    if (!e || !e.pitches.length) return { type: 'idle' };
    if (this.mode !== 'wait' && time < this.due(e) - this.tolerance) return this.record('early', e, time, pitch, e.pitches);
    if (!e.pitches.includes(pitch)) {
      if (this.recentCompleted && time - this.recentCompleted.time <= this.chordWindow) {
        const previous = this.recentCompleted.event;
        return this.record('extra', previous, time, pitch, previous.pitches);
      }
      return this.record(e.pitches.length > 1 && this.matched.size ? 'extra' : 'wrong', e, time, pitch, e.pitches);
    }
    if (this.matched.has(pitch)) return this.record('extra', e, time, pitch, e.pitches);
    if (this.chordStart !== null && time - this.chordStart > this.chordWindow) {
      // 和弦需在窗口内聚合；等待模式允许重新弹奏整组和弦。
      if (this.mode === 'wait') { this.matched.clear(); this.chordStart = time; }
      else return this.record('late', e, time, pitch, e.pitches);
    }
    if (this.chordStart === null) this.chordStart = time;
    this.matched.add(pitch);
    const result = { type:'correct', eventId:e.id, measure:e.measure, pitch, complete:this.matched.size === e.pitches.length, delta:Math.round(time - this.due(e)) };
    if (result.complete) {
      // 用本次演奏时间锚定下一目标，跟随模式允许自然速度波动。
      if (this.mode === 'follow') this.offset += Math.max(-this.tolerance, Math.min(this.tolerance, time - this.due(e)));
      this.advance(time, true);
    }
    return result;
  }
  report(elapsed) {
    const correct = this.results.reduce((n, e) => n + e.correct, 0) + this.matched.size;
    const judged = this.results.reduce((n, e) => n + e.expected, 0) + this.matched.size;
    const mistakes = this.errors.filter(e => e.type !== 'missed').length;
    const total = this.events.reduce((n, e) => n + e.pitches.length, 0);
    return { correct, judged, total, accuracy: judged + mistakes ? Math.round(correct / (judged + mistakes) * 100) : null, completion: total ? Math.round(judged / total * 100) : 0, elapsed:Math.round(elapsed), errors:[...this.errors], results:[...this.results], waits:{...this.waits}, mode:this.mode, bpm:this.bpm };
  }
}
