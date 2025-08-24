
import fs from 'node:fs';
import path from 'node:path';
import protobuf from 'protobufjs';


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

    this.MatchHeader = null;
    this.Chunk = null;
    this.Event = null;
    this.PositionSample = null;


    this.Side = null;
    this.Role = null;

    this.EventType = null;

    this._initialized = false;
  }

  async init(headerObj) {

    this.root = await protobuf.load(this.schemaPath);


    this.MatchHeader = this.root.lookupType('hll.telemetry.MatchHeader');
    this.Chunk = this.root.lookupType('hll.telemetry.Chunk');
    this.Event = this.root.lookupType('hll.telemetry.Event');
    this.PositionSample = this.root.lookupType('hll.telemetry.PositionSample');


    this.Side = this.root.lookupEnum('hll.telemetry.Side');
    this.Role = this.root.lookupEnum('hll.telemetry.Role');
    this.EventType = this.root.lookupEnum('hll.telemetry.EventType');

    fs.mkdirSync(path.dirname(this.outFile), { recursive: true });
    this.out = fs.createWriteStream(this.outFile);

    const headerMsg = this.MatchHeader.create({
      matchId: headerObj.matchId ?? headerObj.match_id,
      mapName: headerObj.mapName ?? headerObj.map_name,
      startMs: headerObj.startMs ?? headerObj.start_ms,
      tickHz: headerObj.tickHz ?? headerObj.tick_hz,
    });
    const err = this.MatchHeader.verify(headerMsg);
    if (err) throw new Error(`MatchHeader verify failed: ${err}`);

    const headerBuf = this.MatchHeader.encodeDelimited(headerMsg).finish();
    this.out.write(headerBuf);
    console.log('Wrote header:', this.MatchHeader.toObject(headerMsg, { defaults: true }));

    this._initialized = true;
  }


  writeChunk(chunk) {
    if (!this._initialized) throw new Error('TelemetryWriter.init(header) must be called first');

    const evts = Array.isArray(chunk.events) ? chunk.events.map(e => this._toEvent(e)).filter(Boolean) : [];
    const pos = Array.isArray(chunk.pos) ? chunk.pos.map(p => this._toPos(p)).filter(Boolean) : [];

    if (evts.length === 0 && pos.length === 0) return;

    const msg = this.Chunk.create({
      startMs: chunk.start_ms ?? chunk.startMs ?? Date.now(),
      events: evts,
      pos: pos,
    });

    const err = this.Chunk.verify(msg);
    if (err) {

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


  _toEvent(e) {
    if (!e || (!e.player_id && !e.playerId) || e.type === undefined) return null;

    const typeV = this.EventType.values[e.type] ?? this.EventType.values.EVT_UNSPEC;


    const evt = {
      tMs: e.t_ms ?? e.tMs ?? Date.now(),
      playerId: String(e.player_id ?? e.playerId ?? ''),
      type: typeV,
    };

    const prevSideV = e.previousSide ? this.Side.values[e.previousSide] ?? this.Side.values.SIDE_UNKNOWN : undefined;
    const sideV = e.side ? this.Side.values[e.side] ?? this.Side.values.SIDE_UNKNOWN : undefined;
    if (prevSideV !== undefined) evt.previousSide = prevSideV;
    if (sideV !== undefined) evt.side = sideV;


    const prevRoleV = e.previousRole ? this.Role.values[e.previousRole] ?? this.Role.values.ROLE_UNKNOWN : undefined;
    const roleV = e.role ? this.Role.values[e.role] ?? this.Role.values.ROLE_UNKNOWN : undefined;
    if (prevRoleV !== undefined) evt.previousRole = prevRoleV;
    if (roleV !== undefined) evt.role = roleV;


    if (typeof e.previousTeam === 'string' && e.previousTeam.length) evt.previousTeam = e.previousTeam;
    if (typeof e.team === 'string' && e.team.length) evt.team = e.team;


    if (typeof e.previousLoadout === 'string' && e.previousLoadout.length) evt.previousLoadout = e.previousLoadout;
    if (typeof e.loadout === 'string' && e.loadout.length) evt.loadout = e.loadout;


    if (e.target_id || e.targetId) evt.targetId = String(e.target_id ?? e.targetId);
    if (e.weapon) evt.weapon = String(e.weapon);


    const err = this.Event.verify(evt);
    if (err) {
      console.error('Event verify failed:', err, 'event:', e);
      return null;
    }
    return evt;
  }


  _toPos(p) {
    if (!p || !(p.player_id || p.playerId)) return null;
    const msg = {
      tMs: p.t_ms ?? p.tMs ?? Date.now(),
      playerId: String(p.player_id ?? p.playerId ?? ''),
      xQ: (p.x_q ?? p.xQ ?? 0) >>> 0,
      yQ: (p.y_q ?? p.yQ ?? 0) >>> 0,
    };
    const err = this.PositionSample.verify(msg);
    if (err) {
      console.error('PositionSample verify failed:', err, 'pos:', p);
      return null;
    }
    return msg;
  }
}
