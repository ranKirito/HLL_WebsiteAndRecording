class IndexMap {
  constructor() {
    this.valueToIndex = new Map();
    this.indexToValue = new Map();
    this.next = 1;
  }
  ensure(value) {
    const key = String(value ?? '');
    if (this.valueToIndex.has(key)) return this.valueToIndex.get(key);
    const idx = this.next++;
    this.valueToIndex.set(key, idx);
    this.indexToValue.set(idx, key);
    return idx;
  }
  toObject() {
    const obj = {};
    for (const [idx, val] of this.indexToValue.entries()) obj[idx] = val;
    return obj;
  }
}

export class Recorder {
  constructor({ serverName, map, tickHz = 2 }) {
    if (!serverName || !map) throw new Error('Recorder requires { serverName, map }');
    this.serverName = serverName;
    this.map = map;
    this.tickHz = tickHz;

    // In-memory recording
    this._chunks = [];
    this._currentChunk = this._newChunk();
    this._timer = null;

    // Dictionaries
    this.players = new IndexMap(); // playerId -> idx
    this.teams = new IndexMap();   // team string -> idx
    this.loadouts = new IndexMap();// loadout string -> idx
    this.weapons = new IndexMap(); // weapon string -> idx
    this.playerNames = new Map();  // playerIdx -> latest display name

    // Player seeds (by player_idx)
    this._seeds = new Map();

    // Movement sampling
    this._lastPos = new Map(); // key: playerIdx
    this._moveMinDtMs = 500;
    this._moveMinDeltaQ = 1;

    this._startMs = Date.now();
  }

  // --- lifecycle ---
  start() {
    if (this._timer) return;
    const intervalMs = Math.floor(1000 / Math.max(1, this.tickHz));
    this._timer = setInterval(() => this.flush(), intervalMs);
  }

  async stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.flush();
  }

  // --- seeding & indices ---
  seedOrUpdatePlayer({ id, name, side, team, loadout, role, joinMs = null, initial = false }) {
    const playerIdx = this.players.ensure(id);
    if (name) this.playerNames.set(playerIdx, String(name));
    const teamIdx = team ? this.teams.ensure(team) : 0;
    const loadoutIdx = loadout ? this.loadouts.ensure(loadout) : 0;
    if (!this._seeds.has(playerIdx)) {
      this._seeds.set(playerIdx, {
        playerIdx,
        joinMs: initial ? 0 : (joinMs ?? Date.now()),
        startSide: side || 'SIDE_UNKNOWN',
        startTeamIdx: teamIdx >>> 0,
        startLoadoutIdx: loadoutIdx >>> 0,
        startRole: role || 'ROLE_UNKNOWN',
      });
    }
    return playerIdx;
  }

  // --- events ---
  eventConnect({ id, name, side, role, team, loadout, initial = false }) {
    const playerIdx = this.seedOrUpdatePlayer({ id, name, side, team, loadout, role, initial });
    this._pushEvent({ tMs: Date.now(), playerIdx, connect: {} });
  }

  eventDisconnect({ id }) {
    const playerIdx = this.players.ensure(id);
    this._pushEvent({ tMs: Date.now(), playerIdx, disconnect: {} });
  }

  eventKill({ killerId, victimId, weapon }) {
    const killerIdx = this.players.ensure(killerId);
    const victimIdx = this.players.ensure(victimId);
    const weaponIdx = this.weapons.ensure(weapon ?? '');
    this._pushEvent({ tMs: Date.now(), playerIdx: killerIdx, kill: { targetIdx: victimIdx, weaponIdx } });
  }

  eventLoadoutSwitch({ id, loadout }) {
    const playerIdx = this.players.ensure(id);
    const loadoutIdx = this.loadouts.ensure(loadout ?? '');
    this._pushEvent({ tMs: Date.now(), playerIdx, loadoutSwitch: { toLoadoutIdx: loadoutIdx } });
  }

  eventTeamSwitch({ id, team }) {
    const playerIdx = this.players.ensure(id);
    const teamIdx = this.teams.ensure(team ?? '');
    this._pushEvent({ tMs: Date.now(), playerIdx, teamSwitch: { toTeamIdx: teamIdx } });
  }

  eventRoleSwitch({ id, role }) {
    const playerIdx = this.players.ensure(id);
    this._pushEvent({ tMs: Date.now(), playerIdx, roleSwitch: { toRole: role || 'ROLE_UNKNOWN' } });
  }

  eventFactionSwitch({ id, side }) {
    const playerIdx = this.players.ensure(id);
    this._pushEvent({ tMs: Date.now(), playerIdx, factionSwitch: { toSide: side || 'SIDE_UNKNOWN' } });
  }

  // --- movement ---
  sampleMovement({ id, x, y }) {
    const tMs = Date.now();
    const playerIdx = this.players.ensure(id);
    const { x_q, y_q } = this._quantize(x, y);
    const last = this._lastPos.get(playerIdx);
    if (last) {
      const dt = tMs - last.tMs;
      const dx = Math.abs(x_q - last.xQ);
      const dy = Math.abs(y_q - last.yQ);
      const movedEnough = dx >= this._moveMinDeltaQ || dy >= this._moveMinDeltaQ;
      if (!movedEnough && dt < this._moveMinDtMs) return;
    }
    this._currentChunk.pos.push({ tMs, playerIdx, xQ: x_q, yQ: y_q });
    this._lastPos.set(playerIdx, { xQ: x_q, yQ: y_q, tMs });
  }

  // --- flushing ---
  flush() {
    if (!this._currentChunk.events.length && !this._currentChunk.pos.length) return;
    this._chunks.push(this._currentChunk);
    this._currentChunk = this._newChunk();
  }

  // --- export ---
  buildHeader({ matchId, mapName, startMs, tickHz } = {}) {
    return {
      matchId: matchId ?? new Date(this._startMs).toISOString(),
      mapName: mapName ?? this.map,
      startMs: startMs ?? this._startMs,
      tickHz: tickHz ?? this.tickHz,
      playerDict: (() => {
        const raw = this.players.toObject(); // idx -> id
        const merged = {};
        for (const [idxStr, idVal] of Object.entries(raw)) {
          const idx = Number(idxStr);
          const name = this.playerNames.get(idx) ?? '';
          merged[idxStr] = `${idVal}|${name}`;
        }
        return merged;
      })(),
      weaponDict: this.weapons.toObject(),
      loadoutDict: this.loadouts.toObject(),
      teamDict: this.teams.toObject(),
      players: Array.from(this._seeds.values()).map((s) => ({
        playerIdx: s.playerIdx >>> 0,
        joinMs: s.joinMs,
        startSide: s.startSide,
        startTeamIdx: s.startTeamIdx >>> 0,
        startLoadoutIdx: s.startLoadoutIdx >>> 0,
        startRole: s.startRole,
      })),
      // Note: names are embedded into playerDict values as "id|name"
    };
  }

  getChunks() { return this._chunks.slice(); }

  // --- internal utilities ---
  _newChunk() { return { startMs: Date.now(), events: [], pos: [] }; }
  _pushEvent(e) { this._currentChunk.events.push(e); }
  _quantize(x, y) { return { x_q: x, y_q: y }; }
}
