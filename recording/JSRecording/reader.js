// TelemetryReader.js
import protobuf from 'protobufjs';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

function toCSV(rows, headers) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map(h => esc(r[h])).join(','));
  return lines.join('\n') + '\n';
}

async function writeFileIf(pathname, content) {
  if (!pathname) return;
  await fsp.writeFile(pathname, content);
}

export class TelemetryReader {
  constructor(opts = {}) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    this.protoPath = opts.protoPath || path.resolve(here, 'recording.proto');
    this.root = null;
    this.MatchHeader = null;
    this.Chunk = null;
    this.Event = null;
    this.PositionSample = null;
  }

  async init() {
    if (this.root) return this;
    this.root = await protobuf.load(this.protoPath);
    this.MatchHeader = this.root.lookupType('hll.telemetry.MatchHeader');
    this.Chunk = this.root.lookupType('hll.telemetry.Chunk');
    this.Event = this.root.lookupType('hll.telemetry.Event');
    this.PositionSample = this.root.lookupType('hll.telemetry.PositionSample');
    return this;
  }

  decodeBuffer(buf) {
    const Reader = protobuf.Reader;
    const r = Reader.create(buf);

    let headerMsg;
    try {
      headerMsg = this.MatchHeader.decodeDelimited(r);
    } catch (err) {
      throw new Error(`Failed to decode MatchHeader: ${err.message}`);
    }

    const chunks = [];
    while (r.pos < r.len) {
      try {
        const msg = this.Chunk.decodeDelimited(r);
        chunks.push(msg);
      } catch (err) {
        if (/(index out of range|truncated)/i.test(String(err.message))) break;
        throw new Error(`Failed decoding Chunk at byte ${r.pos}: ${err.message}`);
      }
    }

    const toObj = (type, m) => type.toObject(m, { defaults: true, enums: String, longs: String });
    return {
      header: toObj(this.MatchHeader, headerMsg),
      chunks: chunks.map((m) => toObj(this.Chunk, m)),
    };
  }

  async readFile(filePath) {
    await this.init();
    const buf = await fsp.readFile(filePath);
    return this.decodeBuffer(buf);
  }

  async *iterateChunks(input) {
    await this.init();
    const buf = Buffer.isBuffer(input) ? input : await fsp.readFile(input);
    const Reader = protobuf.Reader;
    const r = Reader.create(buf);
    // skip header first
    this.MatchHeader.decodeDelimited(r);
    while (r.pos < r.len) {
      const msg = this.Chunk.decodeDelimited(r);
      yield this.Chunk.toObject(msg, { defaults: true, enums: String, longs: String });
    }
  }


  flatten(input) {
    const chunks = Array.isArray(input) ? input : input?.chunks || [];
    const out = { events: [], pos: [] };
    for (const ch of chunks) {
      if (ch && ch.events) out.events.push(...ch.events);
      if (ch && ch.pos) out.pos.push(...ch.pos);
    }
    return out;
  }
}

export async function exportDecodedToFiles({ header, chunks, flat }, { outJson, posCsv, eventsCsv }) {
  // Prepare convenience lookups
  const playerDict = header?.playerDict || header?.player_dict || {};
  const teamDict = header?.teamDict || header?.team_dict || {};
  const weaponDict = header?.weaponDict || header?.weapon_dict || {};
  const loadoutDict = header?.loadoutDict || header?.loadout_dict || {};

  const splitPair = (val) => {
    const s = String(val ?? '');
    const i = s.indexOf('|');
    if (i === -1) return { id: s, name: '' };
    return { id: s.slice(0, i), name: s.slice(i + 1) };
  };
  const idFromIdx = (idx) => splitPair(playerDict?.[String(idx)]).id;
  const nameFromIdx = (idx) => splitPair(playerDict?.[String(idx)]).name;

  if (outJson) {
    const payload = { header, chunks };
    await writeFileIf(outJson, JSON.stringify(payload, null, 2));
  }

  if (posCsv) {
    const headers = ['tMs', 'playerIdx', 'playerId', 'playerName', 'xQ', 'yQ'];
    const rows = (flat?.pos || []).map(p => {
      const idx = p.playerIdx ?? p.player_idx ?? null;
      return {
        tMs: p.tMs ?? p.t_ms ?? '',
        playerIdx: idx ?? '',
        playerId: idx != null ? idFromIdx(idx) : (p.playerId ?? p.player_id ?? ''),
        playerName: idx != null ? nameFromIdx(idx) : '',
        xQ: p.xQ ?? p.x_q ?? '',
        yQ: p.yQ ?? p.y_q ?? '',
      };
    });
    await writeFileIf(posCsv, toCSV(rows, headers));
  }

  if (eventsCsv) {
    const headers = [
      'tMs', 'type', 'playerIdx', 'playerId', 'playerName',
      'targetIdx', 'targetId', 'targetName', 'weaponIdx', 'weapon',
      'toTeamIdx', 'toTeam', 'toRole', 'toSide', 'toLoadoutIdx', 'toLoadout'
    ];

    const rows = (flat?.events || []).map(e => {
      const idx = e.playerIdx ?? e.player_idx ?? null;
      const type = e.connect ? 'CONNECT'
        : e.disconnect ? 'DISCONNECT'
        : e.kill ? 'KILL'
        : e.teamSwitch ? 'TEAM_SWITCH'
        : e.roleSwitch ? 'ROLE_SWITCH'
        : e.factionSwitch ? 'FACTION_SWITCH'
        : e.loadoutSwitch ? 'LOADOUT_SWITCH'
        : '';

      const kill = e.kill || {};
      const teamSwitch = e.teamSwitch || {};
      const roleSwitch = e.roleSwitch || {};
      const factionSwitch = e.factionSwitch || {};
      const loadoutSwitch = e.loadoutSwitch || {};

      const targetIdx = kill.targetIdx ?? kill.target_idx;
      const weaponIdx = kill.weaponIdx ?? kill.weapon_idx;
      const toTeamIdx = teamSwitch.toTeamIdx ?? teamSwitch.to_team_idx;
      const toRole = roleSwitch.toRole ?? roleSwitch.to_role;
      const toSide = factionSwitch.toSide ?? factionSwitch.to_side;
      const toLoadoutIdx = loadoutSwitch.toLoadoutIdx ?? loadoutSwitch.to_loadout_idx;

      return {
        tMs: e.tMs ?? e.t_ms ?? '',
        type,
        playerIdx: idx ?? '',
        playerId: idx != null ? idFromIdx(idx) : (e.playerId ?? e.player_id ?? ''),
        playerName: idx != null ? nameFromIdx(idx) : '',
        targetIdx: targetIdx ?? '',
        targetId: targetIdx != null ? idFromIdx(targetIdx) : '',
        targetName: targetIdx != null ? nameFromIdx(targetIdx) : '',
        weaponIdx: weaponIdx ?? '',
        weapon: weaponIdx != null ? (weaponDict?.[String(weaponIdx)] ?? '') : '',
        toTeamIdx: toTeamIdx ?? '',
        toTeam: toTeamIdx != null ? (teamDict?.[String(toTeamIdx)] ?? '') : '',
        toRole: toRole ?? '',
        toSide: toSide ?? '',
        toLoadoutIdx: toLoadoutIdx ?? '',
        toLoadout: toLoadoutIdx != null ? (loadoutDict?.[String(toLoadoutIdx)] ?? '') : '',
      };
    });
    await writeFileIf(eventsCsv, toCSV(rows, headers));
  }
}

export async function readChunksFromFile(filePath) {
  const rr = new TelemetryReader();
  const { header, chunks } = await rr.readFile(filePath);
  return { header, chunks, flat: rr.flatten(chunks) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const args = process.argv.slice(2);
      if (args.length === 0) {
        console.error('Usage: node reader.js <file> [--out|-out|-o decoded.json] [--pos-csv|-pos pos.csv] [--events-csv|-events events.csv] [--proto path/to/recording.proto]');
        process.exit(1);
      }
      const filePath = args[0];
      const getFlag = (...names) => {
        for (const name of names) {
          const i = args.indexOf(name);
          if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('-')) return args[i + 1];
        }
        return null;
      };
      const outJson = getFlag('--out', '-out', '-o');
      const posCsv = getFlag('--pos-csv', '-pos');
      const eventsCsv = getFlag('--events-csv', '-events');
      const protoOverride = getFlag('--proto', '-proto');

      // Allow overriding the .proto file path from CLI
      const rr = new TelemetryReader(protoOverride ? { protoPath: path.resolve(protoOverride) } : undefined);
      const buf = await fsp.readFile(filePath);
      await rr.init();
      const decoded = rr.decodeBuffer(buf);
      const header = decoded.header;
      const chunks = decoded.chunks;
      const flat = rr.flatten(chunks);

      console.log('Header:', JSON.stringify(header, null, 2));
      console.log('Decoded chunks:', JSON.stringify(chunks, null, 2));
      console.log('Flattened summary:', { events: flat.events.length, pos: flat.pos.length });

      if (outJson || posCsv || eventsCsv) {
        await exportDecodedToFiles({ header, chunks, flat }, { outJson, posCsv, eventsCsv });
        console.log('Written:', {
          json: outJson || null,
          posCsv: posCsv || null,
          eventsCsv: eventsCsv || null,
        });
      }
    } catch (err) {
      console.error('Failed to read file:', err);
      process.exit(1);
    }
  })();
}
