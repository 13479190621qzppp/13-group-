// 原生 Web Audio 采样器。采样来自 tonejs-instruments，见 THIRD_PARTY.md。
export class AudioEngine {
  constructor() { this.context = null; this.buffers = new Map(); this.voices = new Map(); this.volume = .65; this.loading = null; }
  async init() {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain(); this.master.gain.value = this.volume;
      const compressor = this.context.createDynamicsCompressor();
      this.master.connect(compressor); compressor.connect(this.context.destination);
    }
    if (this.context.state !== 'running') await this.context.resume();
  }
  async load(instrument) {
    await this.init();
    const results = await Promise.allSettled(instrument.samples.map(async pitch => {
      const key = `${instrument.id}-${pitch}`;
      if (this.buffers.has(key)) return;
      const response = await fetch(`./samples/${instrument.id}/${pitch}.mp3`);
      if (!response.ok) throw new Error('采样文件未找到');
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
      this.buffers.set(key, buffer);
    }));
    return results.every(r=>r.status==='fulfilled');
  }
  setVolume(value) { this.volume=value; if (this.master) this.master.gain.setTargetAtTime(value,this.context.currentTime,.02); }
  on(id, pitch, instrument, velocity = .8) {
    if (!this.context || this.context.state !== 'running') return;
    this.off(id);
    const time = this.context.currentTime;
    const available = instrument.samples.filter(p=>this.buffers.has(`${instrument.id}-${p}`));
    const nearest = available.sort((a,b)=>Math.abs(a-pitch)-Math.abs(b-pitch))[0];
    const gain = this.context.createGain(); gain.gain.setValueAtTime(0,time); gain.gain.linearRampToValueAtTime(velocity*.7,time+.008); gain.connect(this.master);
    let source;
    if (nearest !== undefined) { source=this.context.createBufferSource(); source.buffer=this.buffers.get(`${instrument.id}-${nearest}`); source.playbackRate.value=2**((pitch-nearest)/12); }
    else { source=this.context.createOscillator(); source.type=instrument.id==='guitar'?'triangle':'sine'; source.frequency.value=440*2**((pitch-69)/12); }
    source.connect(gain); source.start(time);
    const voice={source,gain}; this.voices.set(id,voice);
    source.onended=()=>{ gain.disconnect(); if(this.voices.get(id)===voice) this.voices.delete(id); };
  }
  off(id) {
    const voice=this.voices.get(id); if(!voice) return;
    this.voices.delete(id); const now=this.context.currentTime;
    voice.gain.gain.cancelScheduledValues(now); voice.gain.gain.setTargetAtTime(0,now,.05); voice.source.stop(now+.3);
  }
  stop() { for(const id of [...this.voices.keys()]) this.off(id); }
  click(accent=false) {
    if (!this.context || this.context.state !== 'running') return;
    const time=this.context.currentTime, oscillator=this.context.createOscillator(), gain=this.context.createGain();
    oscillator.frequency.value=accent?1200:850; gain.gain.setValueAtTime(.11,time); gain.gain.exponentialRampToValueAtTime(.001,time+.05);
    oscillator.connect(gain); gain.connect(this.master); oscillator.start(time); oscillator.stop(time+.06); oscillator.onended=()=>gain.disconnect();
  }
}
