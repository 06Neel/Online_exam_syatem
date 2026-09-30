// Live mode engine: thin wrapper over the socket protocol.
import { getSocket, emitAck, on } from '../net.js';

export class LiveEngine {
  constructor({ code, playerId }) {
    this.code = code;
    this.playerId = playerId;
    this.listeners = new Map();
    this.unsubs = [];
    this.currentQIndex = -1;
    this.connected = false;
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(cb);
    return () => this.listeners.get(event)?.delete(cb);
  }

  emit(event, payload) {
    for (const cb of this.listeners.get(event) || []) cb(payload);
  }

  attach() {
    const s = getSocket();
    const add = (event, cb) => this.unsubs.push(on(event, cb));

    add('question:start', (p) => {
      this.currentQIndex = p.qIndex;
      this.lastQuestion = p;
      this.emit('question', p);
    });
    add('question:sync', (p) => {
      this.emit('sync', p);
      if (p.extended) this.emit('time-extended', { endsAt: p.endsAt, extraMs: p.extended });
    });
    add('question:reveal', (p) => this.emit('reveal', p));
    add('leaderboard', (p) => this.emit('leaderboard', p));
    add('quiz:end', (p) => this.emit('end', p.report));
    add('class:mistake', (p) => this.emit('class-mistake', p));
    add('answer:shown', (p) => this.emit('answer-shown', p));
    add('control', (p) => this.emit('control', p));
    add('phase', (p) => this.emit('phase', p));
    add('player:joined', (p) => this.emit('peer-joined', p));

    // server-pushed results (e.g. timed out at reveal time)
    add('answer:accepted', (p) => {
      if (p.playerId && p.playerId !== this.playerId) return;
      this.emit('pushed-result', p);
    });

    // self-paced: the server says this player has answered everything
    add('player:finished', (p) => {
      if (p.playerId && p.playerId !== this.playerId) return;
      this.emit('finished', p);
    });

    this.connected = true;
    return () => { this.unsubs.forEach((u) => u()); this.unsubs = []; };
  }

  async submit(answer) {
    const res = await emitAck('player:answer', { qIndex: this.currentQIndex, answer });
    if (res?.error) return { error: res.error };
    return { result: res.result };
  }

  /** Self-paced Next (or Skip). */
  async advance({ skip = false } = {}) {
    const res = await emitAck('player:advance', { skip });
    if (res?.error) return { error: res.error };
    return res;
  }

  /** Self-paced Back: revisit an earlier question. */
  async goto(qIndex) {
    const res = await emitAck('player:goto', { qIndex });
    if (res?.error) return { error: res.error };
    return res;
  }

  async powerup(kind) {
    const res = await emitAck('player:powerup', { kind });
    return res?.error ? { error: res.error } : res;
  }

  async mini(correct) {
    const res = await emitAck('player:mini', { correct });
    return res || { ok: true, earned: 0 };
  }

  leave() {
    getSocket().emit('player:leave');
  }
}
