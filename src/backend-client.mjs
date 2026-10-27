/** 对现有本地实时练习做「旁路同步」：不阻塞发声；服务掉线不影响练习。 */
export class BackendMirror {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.sessionId = null;
    this.sequence = 0;
    this.token = 0;
    this.queue = Promise.resolve();
    this.ready = Promise.resolve();
    this.lastTick = -1;
    this.active = false;
  }
  async request(path, options = {}) {
    const response = await fetch(path, { ...options, signal: AbortSignal.timeout(7000) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
    return body;
  }
  start(score, options) {
    const token = ++this.token;
    this.sessionId = null;
    this.sequence = 0;
    this.lastTick = -1;
    this.active = true;
    this.onStatus('正在连接练习后端…');
    this.ready = this.request('/api/sessions', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({score,options})
    }).then(data => {
      if (token !== this.token) return null;
      this.sessionId = data.sessionId;
      this.onStatus('Node API 已连接 · 双端判定对照中');
      return data.sessionId;
    }).catch(error => {
      if (token === this.token) {this.active = false;this.onStatus(`后端离线 · 本地练习不受影响`);}
      return null;
    });
    this.queue = this.ready;
  }
  enqueue(job) {
    if (!this.active) return;
    const token = this.token;
    this.queue = this.queue.then(async () => {
      const session = await this.ready;
      if (!session || token !== this.token) return;
      return job(session);
    }).catch(() => {
      if(token === this.token) {this.active=false;this.onStatus('后端同步中断 · 已改用本地判定');}
    });
  }
  event(type, pitch, timestamp, velocity, source) {
    if (!this.active) return;
    const sequence = ++this.sequence;
    this.enqueue(id => this.request(`/api/sessions/${id}/events`, {
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({sequence,type,pitch,timestamp:Math.round(timestamp),velocity,source})
    }));
  }
  tick(timestamp) {
    if (!this.active || timestamp - this.lastTick < 400) return;
    this.lastTick = timestamp;
    this.enqueue(id => this.request(`/api/sessions/${id}/tick`, {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({timestamp:Math.round(timestamp)})
    }));
  }
  finish(timestamp) {
    if (!this.active) return;
    this.enqueue(async id => {
      const result = await this.request(`/api/sessions/${id}/finish`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({timestamp:Math.ceil(timestamp)})
      });
      if(this.sessionId===id) this.onStatus(`服务端已保存本轮统计 · ${result.report.correct}/${result.report.judged} 正确音`);
    });
    this.active=false;
  }
  reset() {
    this.token++;
    this.active=false;
    this.sessionId=null;
    this.queue=Promise.resolve();
    this.ready=Promise.resolve(null);
  }
}
