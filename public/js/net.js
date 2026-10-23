/**
 * Сетевой слой клиента: WebSocket с автоматическим переподключением.
 *
 *  - при обрыве связи пробуем снова с нарастающей задержкой (и сразу, когда вернулась сеть);
 *  - после подключения клиент автоматически «входит обратно» по сохранённому токену,
 *    а сервер присылает полное актуальное состояние;
 *  - heartbeat (ping/pong) обнаруживает «тихо умершие» соединения, которые браузер сам не заметит.
 */
export class Net {
  constructor({ getSession, onStatus, onJoined, onState, onLeft, onResumeFailed }) {
    this.getSession = getSession;
    this.onStatus = onStatus;
    this.onJoined = onJoined;
    this.onState = onState;
    this.onLeft = onLeft;
    this.onResumeFailed = onResumeFailed;
    this.ws = null;
    this.attempt = 0;
    this.nextId = 1;
    this.pending = new Map();
    this.retryTimer = null;
    this.beatTimer = null;
    this.pongTimer = null;
  }

  get open() { return !!this.ws && this.ws.readyState === 1; }

  start() {
    window.addEventListener('online', () => this.reconnectNow());
    window.addEventListener('offline', () => this.dead());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (this.open) this.beat(); else this.reconnectNow();
    });
    this.connect();
  }

  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    clearTimeout(this.retryTimer);
    this.onStatus('connecting', this.attempt);
    let ws;
    try {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.onStatus('online', 0);
      this.startBeat();
      const s = this.getSession();
      if (s) {
        this.request('join', { room: s.room, token: s.token, name: s.name }).catch((err) => {
          if (!err.network) this.onResumeFailed(err);
        });
      }
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      this.onMessage(m);
    };
    ws.onclose = () => { if (this.ws === ws) this.lost(); };
    ws.onerror = () => { /* onclose последует сам */ };
  }

  onMessage(m) {
    switch (m.t) {
      case 'ack': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.data); else p.reject(Object.assign(new Error(m.error || 'Ошибка'), { code: m.code }));
        return;
      }
      case 'state': this.onState(m); return;
      case 'joined': this.onJoined(m); return;
      case 'left': this.onLeft(m); return;
      case 'pong':
        clearTimeout(this.pongTimer);
        return;
      default:
    }
  }

  request(t, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!this.open) {
        reject(Object.assign(new Error('Нет соединения с сервером'), { network: true }));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('Сервер не ответил'), { network: true }));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ t, id, ...payload }));
    });
  }

  /* ───── heartbeat ───── */

  startBeat() {
    this.stopBeat();
    this.beatTimer = setInterval(() => this.beat(), 8000);
  }

  stopBeat() {
    clearInterval(this.beatTimer);
    clearTimeout(this.pongTimer);
  }

  beat() {
    if (!this.open) return;
    clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => this.dead(), 5000);
    try { this.ws.send(JSON.stringify({ t: 'ping', ts: Date.now() })); } catch { this.dead(); }
  }

  dead() {
    const ws = this.ws;
    if (!ws) return;
    ws.onclose = null;
    try { ws.close(); } catch { /* уже закрыт */ }
    this.lost();
  }

  lost() {
    this.stopBeat();
    this.ws = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error('Соединение потеряно'), { network: true }));
    }
    this.pending.clear();
    this.onStatus('offline', this.attempt);
    this.scheduleRetry();
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    const delay = Math.min(8000, 400 * 2 ** this.attempt) + Math.random() * 300;
    this.attempt++;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  reconnectNow() {
    if (this.open) { this.beat(); return; }
    clearTimeout(this.retryTimer);
    this.attempt = 0;
    this.connect();
  }
}
