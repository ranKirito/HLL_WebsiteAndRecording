// writer.js
// npm i protobufjs
import fs from 'node:fs';
import path from 'node:path';
import protobuf from 'protobufjs';

/**
 * Robust enum helper:
 * - Accepts string names ("ALLIES") or numeric values (1)
 * - Falls back to 0 (UNKNOWN) when missing
 */
function enumValue(enumType, v, unknownName = null) {
  if (v === undefined || v === null) return undefined; // keep sparse if absent
  if (typeof v === 'number') {
    // ensure it's a valid numeric member
    const ok = Object.values(enumType.values).includes(v);
    return ok ? v : (unknownName && enumType.values[unknownName]) ?? 0;
  }
  if (typeof v === 'string') {
    // allow case-insensitive names
    const key = v.toUpperCase();
    const direct = enumType.values[key];
    if (direct !== undefined) return direct;
    // sometimes you'll pass "Axis"/"Allies" → map to your proto names
    if (key === 'AXIS' && enumType.values.AXIS !== undefined) return enumType.values.AXIS;
    if (key === 'ALLIES' && enumType.values.ALLIES !== undefined) return enumType.values.ALLIES;
    if (unknownName && enumType.values[unknownName] !== undefined) return enumType.values[unknownName];
    return 0;
  }
  return (unknownName && enumType.values[unknownName]) ?? 0;
}

/**
 * TelemetryWriter:
 *  - call init() once with header
 *  - call writeChunk(recorderChunk) for every flush
 *  - call close() at the end
 */
export class TelemetryWriter {
  /**
   * @param {object} opts
   * @param {string} opts.schemaPath   - path to JSRecording/recording.proto
   * @param {string} opts.outFile      - output file path (.pb)
   */
  constructor({ schemaPath, outFile }) {
    if (!schemaPath || !outFile) {
      throw new Error('TelemetryWriter requires { schemaPath, outFile }');
    }
    this.schemaPath = schemaPath;
    this.outFile = outFile;
    this.out = null;
    this.root = null;

    // types (lazy after init)
    this.MatchHeader = null;
    this.Chunk = null;
    this.Event = null;
    this.PositionSample = null;

    // enums
    this.Side = null;
    this.Role = null;
    this.Team = null;
    this.Loadouts = null;
    this.EventType = null;

    this._initialized = false;
  }

  async init(headerObj) {
    // load schema
    this.root = await protobuf.load(this.schemaPath);

    // resolve message types
    this.MatchHeader = this.root.lookupType('hll.telemetry.MatchHeader');
    this.Chunk = this.root.lookupType('hll.telemetry.Chunk');
    this.Event = this.root.lookupType('hll.telemetry.Event');
    this.PositionSample = this.root.lookupType('hll.telemetry.PositionSample');

    // resolve enums
    this.Side = this.root.lookupEnum('hll.telemetry.Side');
    this.Role = this.root.lookupEnum('hll.telemetry.Role');
    this.Team = this.root.lookupEnum('hll.telemetry.Team');       // currently sparse in your proto
    this.Loadouts = this.root.lookupEnum('hll.telemetry.Loadouts');   // currently empty in your proto
    this.EventType = this.root.lookupEnum('hll.telemetry.EventType');

    // create stream directory if needed
    fs.mkdirSync(path.dirname(this.outFile), { recursive: true });
    this.out = fs.createWriteStream(this.outFile);

    // validate + write header (encodeDelimited)
    const headerMsg = this.MatchHeader.create(headerObj);
    const err = this.MatchHeader.verify(headerMsg);
    if (err) throw new Error(`MatchHeader verify failed: ${err}`);

    const headerBuf = this.MatchHeader.encodeDelimited(headerMsg).finish();
    this.out.write(headerBuf);

    this._initialized = true;
  }

  /**
   * Write a recorder chunk to file.
   * Expects `{ start_ms, events: [...], pos: [...] }` shape from your Recorder.
   */
  writeChunk(chunk) {
    if (!this._initialized) throw new Error('TelemetryWriter.init(header) must be called first');

    const evts = Array.isArray(chunk.events) ? chunk.events.map(e => this._toEvent(e)).filter(Boolean) : [];
    const pos = Array.isArray(chunk.pos) ? chunk.pos.map(p => this._toPos(p)).filter(Boolean) : [];

    if (evts.length === 0 && pos.length === 0) return; // skip empty chunks

    const msg = this.Chunk.create({
      start_ms: chunk.start_ms ?? Date.now(),
      events: evts,
      pos: pos,
    });

    const err = this.Chunk.verify(msg);
    if (err) {
      // Don't throw; log and skip faulty chunk to keep recording resilient
      console.error('Chunk verify failed:', err);
      return;
    }

    const buf = this.Chunk.encodeDelimited(msg).finish();
    this.out.write(buf);
  }

  close() {
    if (this.out) {
      this.out.end();
      this.out = null;
    }
    this._initialized = false;
  }

  // --- internal mapping helpers ---

  /**
   * Recorder event → proto Event
   * Recorder usually sends sparse objects with:
   *  - t_ms, player_id, type (string or number)
   *  - side/previousSide (string or number)
   *  - role/previousRole (string or number)
   *  - team/previousTeam   (string or number; not used yet if you don’t track squads)
   *  - loadout/previousLoadout (string or number; your enum is empty, so this will default to 0)
   *  - target_id, weapon (strings)
   */
  _toEvent(e) {
    if (!e || !e.player_id || !e.type) return null;

    const typeV = enumValue(this.EventType, e.type, 'EVT_UNSPEC');

    // Only set fields that exist → stays sparse on wire
    const evt = {
      t_ms: e.t_ms ?? Date.now(),
      player_id: String(e.player_id),
      type: typeV,
    };

    // Sides (faction): accept strings ("Axis"/"Allies" or "AXIS"/"ALLIES") or numbers
    const prevSideV = enumValue(this.Side, e.previousSide, 'SIDE_UNKNOWN');
    const sideV = enumValue(this.Side, e.side, 'SIDE_UNKNOWN');
    if (prevSideV !== undefined) evt.previousSide = prevSideV;
    if (sideV !== undefined) evt.side = sideV;

    // Roles
    const prevRoleV = enumValue(this.Role, e.previousRole, 'ROLE_UNKNOWN');
    const roleV = enumValue(this.Role, e.role, 'ROLE_UNKNOWN');
    if (prevRoleV !== undefined) evt.previousRole = prevRoleV;
    if (roleV !== undefined) evt.role = roleV;

    // Team (squad) — your enum is incomplete; still safe to map if you pass names like "MIKE"
    const prevTeamV = enumValue(this.Team, e.previousTeam, null);
    const teamV = enumValue(this.Team, e.team, null);
    if (prevTeamV !== undefined) evt.previousTeam = prevTeamV;
    if (teamV !== undefined) evt.team = teamV;

    // Loadouts (enum empty => will resolve to 0 if you pass something; harmless)
    const prevLoadV = enumValue(this.Loadouts, e.previousLoadout, null);
    const loadV = enumValue(this.Loadouts, e.loadout, null);
    if (prevLoadV !== undefined) evt.previousLoadout = prevLoadV;
    if (loadV !== undefined) evt.loadout = loadV;

    // Kill-specific fields
    if (e.target_id) evt.target_id = String(e.target_id);
    if (e.weapon) evt.weapon = String(e.weapon);

    // Final verify per-event (optional; remove in hot paths)
    const err = this.Event.verify(evt);
    if (err) {
      console.error('Event verify failed:', err, 'event:', e);
      return null;
    }
    return evt;
  }

  /**
   * Recorder position → proto PositionSample
   * Recorder provides quantized x_q/y_q already; if not, quantize before calling writeChunk.
   */
  _toPos(p) {
    if (!p || !p.player_id) return null;
    const msg = {
      t_ms: p.t_ms ?? Date.now(),
      player_id: String(p.player_id),
      x_q: p.x_q >>> 0, // ensure uint32
      y_q: p.y_q >>> 0,
    };
    const err = this.PositionSample.verify(msg);
    if (err) {
      console.error('PositionSample verify failed:', err, 'pos:', p);
      return null;
    }
    return msg;
  }
}
