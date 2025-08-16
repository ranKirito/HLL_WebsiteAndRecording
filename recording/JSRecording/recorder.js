// Lightweight, front-end friendly recorder that buffers gameplay events
// and movement samples, then flushes them periodically to a caller-provided
// handler (e.g., a Protobuf writer using protobufjs encodeDelimited).
//
// Usage example (outside):
//   const rec = new Recorder({
//     serverName: 'My Server',
//     map: 'Foy Warfare',
//     bounds: { minX: -5000, maxX: 5000, minY: -5000, maxY: 5000 },
//     tickHz: 2,
//     onFlush: (chunk) => writer.writeChunk(chunk),
//   });
//   rec.start();
//   from hll-ircon events:
//   rec.eventConnect({ id: steamId, side: 'Allies' });
//   rec.eventKill({ killerId, victimId, weapon });
//   movement sampling (call every second with current pos):
//   rec.sampleMovement({ id: steamId, x, y, side: 'Allies', role: 'RIFLEMAN' });
//   on match end:
//   await rec.stop();

export class Recorder {
  constructor({ serverName, map, bounds, tickHz = 2, onFlush }) {
    if (!serverName || !map || !bounds || !onFlush) {
      throw new Error('Recorder requires { serverName, map, bounds, onFlush }');
    }
    this.serverName = serverName;
    this.map = map;
    this.bounds = bounds; // { minX, maxX, minY, maxY }
    this.tickHz = tickHz;
    this.onFlush = onFlush; // function (chunk) => void
    this.MAXQ = 4095; // quantization grid

    // internal buffers
    this._currentChunk = this._newChunk();
    this._timer = null;

    // movement de-dupe state
    this._lastPos = new Map(); // playerId -> { x_q, y_q, t_ms }
    this._moveMinDtMs = 500;   // only record at least every 500ms per player
    this._moveMinDeltaQ = 1;   // at least 1 quantized cell change
  }

  // --- public getters ---
  get NameOfServer() { return this.serverName; }
  get Map() { return this.map; }


  // --- lifecycle ---
  start() {
    if (this._timer) return;
    const intervalMs = Math.floor(1000 / Math.max(1, this.tickHz)); // real control
    this._timer = setInterval(() => this.flush(), intervalMs);
  }

  async stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.flush();
  }

  // --- event helpers ---
  // Enums are strings here; translate to your numeric enums in the writer if needed.
  eventConnect({ id, side }) {
    this._pushEvent({ t_ms: Date.now(), player_id: id, type: 'CONNECT', side });
  }

  eventDisconnect({ id }) {
    this._pushEvent({ t_ms: Date.now(), player_id: id, type: 'DISCONNECT' });
  }

  eventKill({ killerId, victimId, weapon, side }) {
    this._pushEvent({ t_ms: Date.now(), player_id: killerId, type: 'KILL', target_id: victimId, weapon });
  }

  eventLoadoutSwitch({ id, previousLoadout, loadout }) {
    this._pushEvent({ t_ms: Date.now(), player_id: id, type: 'LOADOUT_SWITCH', previousLoadout, loadout });
  }

  eventTeamSwitch({ id, previousTeam, team }) {
    this._pushEvent({ t_ms: Date.now(), player_id: id, type: 'TEAM_SWITCH', previousTeam, team });
  }

  eventRoleSwitch({ id, previousRole, role }) {
    this._pushEvent({ t_ms: Date.now(), player_id: id, type: 'ROLE_SWITCH', previousRole, role });
  }

  eventFactionSwitch({ id, previousSide, side }) {
    this._pushEvent({ t_ms: Date.now(), player_id: id, type: 'FACTION_SWITCH', previousSide, side });
  }

  // Call this every second with the latest position.
  sampleMovement({ id, x, y }) {
    const t_ms = Date.now();
    const { x_q, y_q } = this._quantize(x, y);
    const last = this._lastPos.get(id);

    if (last) {
      const dt = t_ms - last.t_ms;
      const dx = Math.abs(x_q - last.x_q);
      const dy = Math.abs(y_q - last.y_q);
      const movedEnough = dx >= this._moveMinDeltaQ || dy >= this._moveMinDeltaQ;
      if (!movedEnough && dt < this._moveMinDtMs) return; // skip redundant sample
    }

    this._currentChunk.pos.push({ t_ms, player_id: id, x_q, y_q });
    this._lastPos.set(id, { x_q, y_q, t_ms });
  }

  // --- flushing ---
  flush() {
    if (!this._currentChunk.events.length && !this._currentChunk.pos.length) return;
    try {
      this.onFlush({ ...this._currentChunk });
    } finally {
      this._currentChunk = this._newChunk();
    }
  }

  // --- internal utilities ---
  _newChunk() {
    return { start_ms: Date.now(), events: [], pos: [] };
  }

  _pushEvent(e) {
    this._currentChunk.events.push(e);
  }

  _quantize(x, y) {
    const { minX, maxX, minY, maxY } = this.bounds;
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    const norm = (v, a, b) => (clamp(v, a, b) - a) / (b - a || 1);
    const q = (r) => Math.round(r * this.MAXQ);
    return { x_q: q(norm(x, minX, maxX)), y_q: q(norm(y, minY, maxY)) };
  }
}
