export class Recorder {
  constructor({ serverName, map, tickHz = 2, onFlush }) {
    if (!serverName || !map || !onFlush) {
      throw new Error('Recorder requires { serverName, map, bounds, onFlush }');
    }
    this.serverName = serverName;
    this.map = map;
    this.tickHz = tickHz;
    this.onFlush = onFlush;


    this._currentChunk = this._newChunk();
    this._timer = null;


    this._lastPos = new Map();
    this._moveMinDtMs = 500;   // only record at least every 500ms per player
    this._moveMinDeltaQ = 1;
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


  eventConnect({ id, side, role, team, loadout }) {
    this._pushEvent({ t_ms: Date.now(), player_id: id, type: 'CONNECT', side, role, team, loadout });
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

  sampleMovement({ id, x, y }) {
    const t_ms = Date.now();
    const { x_q, y_q } = this._quantize(x, y);
    const last = this._lastPos.get(id);

    if (last) {
      const dt = t_ms - last.t_ms;
      const dx = Math.abs(x_q - last.x_q);
      const dy = Math.abs(y_q - last.y_q);
      const movedEnough = dx >= this._moveMinDeltaQ || dy >= this._moveMinDeltaQ;
      if (!movedEnough && dt < this._moveMinDtMs) return;
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
    return { x_q: x, y_q: y };
  }
}
