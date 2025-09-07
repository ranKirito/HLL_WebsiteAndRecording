
import fs from 'node:fs';
import path from 'node:path';
import protobuf from 'protobufjs';

// Encodes a full in-memory recording (header + chunks) to a file at once.
export class TelemetryWriter {
  constructor({ schemaPath, outFile }) {
    if (!schemaPath || !outFile) throw new Error('TelemetryWriter requires { schemaPath, outFile }');
    this.schemaPath = schemaPath;
    this.outFile = outFile;
    this.root = null;
    this.MatchHeader = null;
    this.Chunk = null;
    this.Event = null;
    this.PositionSample = null;
    this.Side = null;
    this.Role = null;
  }

  async _initTypes() {
    if (this.root) return;
    this.root = await protobuf.load(this.schemaPath);
    this.MatchHeader = this.root.lookupType('hll.telemetry.MatchHeader');
    this.Chunk = this.root.lookupType('hll.telemetry.Chunk');
    this.Event = this.root.lookupType('hll.telemetry.Event');
    this.PositionSample = this.root.lookupType('hll.telemetry.PositionSample');
    this.Side = this.root.lookupEnum('hll.telemetry.Side');
    this.Role = this.root.lookupEnum('hll.telemetry.Role');
  }

  async writeAll({ header, chunks }) {
    await this._initTypes();
    fs.mkdirSync(path.dirname(this.outFile), { recursive: true });
    const out = fs.createWriteStream(this.outFile);

    // Header
    const headerMsg = this.MatchHeader.create({
      matchId: header.matchId ?? header.match_id,
      mapName: header.mapName ?? header.map_name,
      startMs: header.startMs ?? header.start_ms,
      tickHz: header.tickHz ?? header.tick_hz,
      playerDict: header.playerDict ?? header.player_dict ?? {},
      weaponDict: header.weaponDict ?? header.weapon_dict ?? {},
      loadoutDict: header.loadoutDict ?? header.loadout_dict ?? {},
      teamDict: header.teamDict ?? header.team_dict ?? {},
      players: header.players || [],
    });
    const headerErr = this.MatchHeader.verify(headerMsg);
    if (headerErr) throw new Error(`MatchHeader verify failed: ${headerErr}`);
    out.write(this.MatchHeader.encodeDelimited(headerMsg).finish());

    // Chunks
    for (const ch of chunks || []) {
      const msg = this.Chunk.create({
        startMs: ch.startMs ?? ch.start_ms ?? Date.now(),
        events: (ch.events || []).map((e) => this._eventFromInMem(e)).filter(Boolean),
        pos: (ch.pos || []).map((p) => this._posFromInMem(p)).filter(Boolean),
      });
      const err = this.Chunk.verify(msg);
      if (err) throw new Error(`Chunk verify failed: ${err}`);
      out.write(this.Chunk.encodeDelimited(msg).finish());
    }

    await new Promise((res, rej) => {
      out.end(() => res());
      out.on('error', rej);
    });
  }

  _eventFromInMem(e) {
    if (!e) return null;
    const base = {
      tMs: e.tMs ?? e.t_ms ?? Date.now(),
      playerIdx: (e.playerIdx ?? e.player_idx ?? 0) >>> 0,
    };
    // oneof payloads
    if (e.connect) return { ...base, connect: {} };
    if (e.disconnect) return { ...base, disconnect: {} };
    if (e.kill) {
      return {
        ...base,
        kill: {
          targetIdx: (e.kill.targetIdx ?? e.kill.target_idx ?? 0) >>> 0,
          weaponIdx: (e.kill.weaponIdx ?? e.kill.weapon_idx ?? 0) >>> 0,
        },
      };
    }
    if (e.teamSwitch) {
      return { ...base, teamSwitch: { toTeamIdx: (e.teamSwitch.toTeamIdx ?? e.teamSwitch.to_team_idx ?? 0) >>> 0 } };
    }
    if (e.roleSwitch) {
      const val = e.roleSwitch.toRole ?? e.roleSwitch.to_role;
      let enc;
      if (typeof val === 'string') enc = this.Role.values[val] ?? this.Role.values.ROLE_UNKNOWN;
      else enc = (val >>> 0);
      return { ...base, roleSwitch: { toRole: enc } };
    }
    if (e.factionSwitch) {
      const val = e.factionSwitch.toSide ?? e.factionSwitch.to_side;
      let enc;
      if (typeof val === 'string') enc = this.Side.values[val] ?? this.Side.values.SIDE_UNKNOWN;
      else enc = (val >>> 0);
      return { ...base, factionSwitch: { toSide: enc } };
    }
    if (e.loadoutSwitch) {
      return { ...base, loadoutSwitch: { toLoadoutIdx: (e.loadoutSwitch.toLoadoutIdx ?? e.loadoutSwitch.to_loadout_idx ?? 0) >>> 0 } };
    }
    return null;
  }

  _posFromInMem(p) {
    if (!p) return null;
    const msg = {
      tMs: p.tMs ?? p.t_ms ?? Date.now(),
      playerIdx: (p.playerIdx ?? p.player_idx ?? 0) >>> 0,
      xQ: (p.xQ ?? p.x_q ?? 0) >>> 0,
      yQ: (p.yQ ?? p.y_q ?? 0) >>> 0,
    };
    const err = this.PositionSample.verify(msg);
    if (err) {
      // Keep robust but warn
      console.error('PositionSample verify failed:', err, 'pos:', p);
      return null;
    }
    return msg;
  }
}

export async function writeRecordingToFile({ schemaPath, outFile, header, chunks }) {
  const w = new TelemetryWriter({ schemaPath, outFile });
  await w.writeAll({ header, chunks });
}
