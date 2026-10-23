'use strict';
/**
 * Минимальная реализация WebSocket-сервера (RFC 6455) без внешних зависимостей:
 * рукопожатие, текстовые кадры, фрагментация, ping/pong, close.
 * Так проект остаётся «чистым JavaScript» и разворачивается где угодно без npm install.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 16 * 1024;           // клиентские сообщения маленькие
const MAX_BACKLOG = 2 * 1024 * 1024;     // если клиент не читает — отключаем

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127;
    header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
    this.closed = false;
    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._finish());
    socket.on('error', () => this._finish());
    socket.on('end', () => this._finish());
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  send(text) {
    if (this.closed || !this.socket.writable) return;
    if (this.socket.writableLength > MAX_BACKLOG) { this.terminate(); return; }
    this.socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8')));
  }

  ping() {
    if (this.closed || !this.socket.writable) return;
    this.socket.write(encodeFrame(0x9, Buffer.alloc(0)));
  }

  close(code = 1000) {
    if (this.closed) return;
    try {
      const p = Buffer.alloc(2); p.writeUInt16BE(code, 0);
      this.socket.write(encodeFrame(0x8, p));
      this.socket.end();
    } catch { /* сокет уже закрыт */ }
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this._finish();
  }

  terminate() {
    this.socket.destroy();
    this._finish();
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = !!(b0 & 0x80);
      const opcode = b0 & 0x0f;
      const masked = !!(b1 & 0x80);
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        if (this.buf.readUInt32BE(2) > 0) return this.close(1009);
        len = this.buf.readUInt32BE(6); off = 10;
      }
      if (len > MAX_PAYLOAD) return this.close(1009);
      if (!masked) return this.close(1002); // клиент обязан маскировать кадры
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this._frame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  _frame(fin, opcode, payload) {
    switch (opcode) {
      case 0x8: // close
        this.close(1000);
        return;
      case 0x9: // ping → pong
        if (this.socket.writable) this.socket.write(encodeFrame(0xA, payload));
        return;
      case 0xA: // pong
        this.emit('pong');
        return;
      case 0x1: case 0x2: case 0x0: {
        if (opcode !== 0x0) { this.fragOpcode = opcode; this.fragments = []; }
        this.fragments.push(payload);
        const total = this.fragments.reduce((s, b) => s + b.length, 0);
        if (total > MAX_PAYLOAD) return this.close(1009);
        if (!fin) return;
        const data = Buffer.concat(this.fragments);
        this.fragments = [];
        if (this.fragOpcode === 0x1) this.emit('message', data.toString('utf8'));
        else this.close(1003); // бинарные данные не поддерживаем
        return;
      }
      default:
        this.close(1002);
    }
  }
}

/** Завершает рукопожатие и возвращает WSConnection (или null, если запрос некорректен). */
function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (!key || upgrade !== 'websocket' || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return new WSConnection(socket);
}

module.exports = { acceptUpgrade, WSConnection };
