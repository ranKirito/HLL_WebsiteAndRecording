// TelemetryReader.js
import protobuf from 'protobufjs';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

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
    const here = path.dirname(new URL(import.meta.url).pathname);
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
  if (outJson) {
    const payload = { header, chunks };
    await writeFileIf(outJson, JSON.stringify(payload, null, 2));
  }
  if (posCsv) {
    const headers = ['tMs', 'playerId', 'xQ', 'yQ'];
    const rows = (flat?.pos || []).map(p => ({
      tMs: p.tMs ?? p.t_ms ?? '',
      playerId: p.playerId ?? p.player_id ?? '',
      xQ: p.xQ ?? p.x_q ?? '',
      yQ: p.yQ ?? p.y_q ?? '',
    }));
    await writeFileIf(posCsv, toCSV(rows, headers));
  }
  // Events CSV
  if (eventsCsv) {
    const headers = ['tMs', 'playerId', 'type', 'previousSide', 'side', 'previousRole', 'role', 'previousTeam', 'team', 'previousLoadout', 'loadout', 'targetId', 'weapon'];
    const rows = (flat?.events || []).map(e => ({
      tMs: e.tMs ?? e.t_ms ?? '',
      playerId: e.playerId ?? e.player_id ?? '',
      type: e.type ?? '',
      previousSide: e.previousSide ?? '',
      side: e.side ?? '',
      previousRole: e.previousRole ?? '',
      role: e.role ?? '',
      previousTeam: e.previousTeam ?? '',
      team: e.team ?? '',
      previousLoadout: e.previousLoadout ?? '',
      loadout: e.loadout ?? '',
      targetId: e.targetId ?? e.target_id ?? '',
      weapon: e.weapon ?? '',
    }));
    await writeFileIf(eventsCsv, toCSV(rows, headers));
  }
}

export async function readChunksFromFile(filePath) {
  const rr = new TelemetryReader();
  const { header, chunks } = await rr.readFile(filePath);
  return { header, chunks, flat: rr.flatten(chunks) };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  (async () => {
    try {
      const args = process.argv.slice(2);
      if (args.length === 0) {
        console.error('Usage: node reader.js <file> [--out decoded.json] [--pos-csv pos.csv] [--events-csv events.csv]');
        process.exit(1);
      }
      const filePath = args[0];
      const getFlag = (name) => {
        const i = args.indexOf(name);
        return i !== -1 && args[i + 1] ? args[i + 1] : null;
      };
      const outJson = getFlag('--out');
      const posCsv = getFlag('--pos-csv');
      const eventsCsv = getFlag('--events-csv');

      const { header, chunks, flat } = await readChunksFromFile(filePath);

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
