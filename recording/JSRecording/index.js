import { IRCONClient } from 'hll-ircon';
import { Recorder } from './recorder.js';
import { TelemetryWriter } from './writer.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from "dotenv";
dotenv.config();

const sideFromFactionString = (s) => {
  if (s === 'Allies') return 'ALLIES';
  if (s === 'Axis') return 'AXIS';
  return 'SIDE_UNKNOWN';
};
const roleToEnum = (n) => (n === 9 ? "OFFICER" : n === 7 ? "ANTI_TANK" : n === 5 ? "SUPPORT" : n === 8 ? "ENGINEER" : n === 1 ? "ASSAULT" : n === 0 ? "RIFLEMAN" : n === 3 ? "MEDIC" : n === 13 ? "COMMANDER" : n === 4 ? "SPOTTER" : n === 12 ? "TANK_COMMANDER" : n === 2 ? 'AUTOMATIC_RIFLEMAN' : n === 6 ? "MACHINE_GUNNER" : n === 10 ? 'SNIPER' : n === 11 ? 'CREWMAN' : 'ROLE_UNKNOWN');

const teamToSide = (t) => (t === 2 ? 'ALLIES' : t === 0 ? 'AXIS' : 'SIDE_UNKNOWN');

const printableServerName = (serverName) => {
  if (serverName && typeof serverName === 'object') {
    return serverName.Value || serverName.name || JSON.stringify(serverName);
  }
  return serverName;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT_DIR = path.resolve(__dirname, '../out');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function seedInitialState(rec, roster) {
  for (const p of roster) {
    rec.eventConnect({ id: p.iD, side: teamToSide(p.team), role: roleToEnum(p.role), team: p.platoon, loadout: p.loadout });
    if (p.worldPosition) {
      rec.sampleMovement({
        id: p.iD,
        x: p.worldPosition.x,
        y: p.worldPosition.y,
      });
    }
  }
  rec.flush();
}

const client = new IRCONClient({
  host: process.env.HOST,
  port: process.env.PORT,
  password: process.env.PASSWORD,
});

client.on('ready', async () => {
  const serverNameRaw = await client.v2.server.getServerName();
  const serverName = printableServerName(serverNameRaw);
  console.log('Logged in to server:', serverName);

  const sessionInfo = await client.v2.session.getSession();
  console.log(`Session started: map=${sessionInfo?.session?.mapName}, players=${sessionInfo?.session?.playerCount ?? 0}`);

  const outFile = path.join(
    OUT_DIR,
    `match_${new Date().toISOString().replace(/[:.]/g, '-')}.hll`
  );

  const writer = new TelemetryWriter({

    schemaPath: path.resolve(__dirname, 'recording.proto'),
    outFile,
  });
  console.log('Telemetry file will be written to:', outFile);
  try {
    await writer.init({
      match_id: new Date().toISOString().replace(/[:.]/g, '-'),
      map_name: sessionInfo?.session?.mapName ?? 'Unknown',
      start_ms: Date.now(),
      tick_hz: 2,
    });
  } catch (err) {
    console.error('Failed to initialize TelemetryWriter:', err);
    throw err;
  }

  // --- initial players snapshot ---
  const initialPlayersResp = await client.v2.players.fetch();
  const playersPlaying = initialPlayersResp?.players ?? [];
  let previousPlayersInfo = playersPlaying.slice();

  const recorder = new Recorder({
    serverName,
    map: sessionInfo.session.mapName,
    tickHz: 2,
    onFlush: (chunk) => {
      writer.writeChunk(chunk);
    },
  });

  await seedInitialState(recorder, playersPlaying);
  recorder.start();

  const movementTimer = setInterval(async () => {
    try {
      const curResp = await client.v2.players.fetch();
      const cur = curResp?.players ?? [];
      const prevList = Array.isArray(previousPlayersInfo) ? previousPlayersInfo : [];
      const prevById = new Map(prevList.map(pp => [pp.iD, pp]));
      for (const p of cur) {
        if (!p.worldPosition) continue;
        recorder.sampleMovement({
          id: p.iD,
          x: p.worldPosition.x,
          y: p.worldPosition.y,
        });
        const prev = prevById.get(p.iD);
        if (prev) {
          if (p.platoon !== prev.platoon) {
            console.log(`TEAM SWITCH: Player ${p.iD} from team ${prev.platoon} -> ${p.platoon}`);
            recorder.eventTeamSwitch({
              id: p.iD,
              previousTeam: prev.platoon,
              team: p.platoon,
            });
          }
          if (p.role !== prev.role) {
            console.log(`ROLE SWITCH: Player ${p.iD} from ${roleToEnum(prev.role)} -> ${roleToEnum(p.role)}`);
            recorder.eventRoleSwitch({
              id: p.iD,
              previousRole: roleToEnum(prev.role),
              role: roleToEnum(p.role),
            });
          }
          if (p.loadout !== prev.loadout) {
            console.log(`LOADOUT SWITCH: Player ${p.iD} from ${prev.loadout} -> ${p.loadout}`);
            recorder.eventLoadoutSwitch({
              id: p.iD,
              previousLoadout: prev.loadout,
              loadout: p.loadout,
            });
          }
        }
      }

      previousPlayersInfo = cur;
    } catch (e) {
      console.error('movement poll failed:', e);
    }
  }, 1000);

  client.on('playerConnected', async (evt) => {
    const p = evt?.player || (await client.v2.players.get?.(evt?.parsed?.playerId));
    if (!p) return;
    console.log(`CONNECT: Player ${p.iD} joined as ${roleToEnum(p.role)} on ${teamToSide(p.team)}`);
    recorder.eventConnect({ id: p.iD, side: teamToSide(p.team), role: roleToEnum(p.role), team: p.platoon, loadout: p.loadout });
  });

  client.on('playerDisconnected', (evt) => {
    const id = evt?.parsed?.playerId || evt?.player?.iD;
    if (id) {
      console.log(`DISCONNECT: Player ${id} left the server`);
      recorder.eventDisconnect({ id });
    }
  });

  client.on('playerSwitchFaction', (evt) => {
    const id = evt?.parsed?.playerId || evt?.player?.iD;
    const prev = sideFromFactionString(evt?.parsed?.oldFaction);
    const next = sideFromFactionString(evt?.parsed?.newFaction);
    console.log(`FACTION SWITCH: Player ${id} ${prev} -> ${next}`);
    if (id && prev !== next) {
      if (!(prev === 'SIDE_UNKNOWN' && next === 'SIDE_UNKNOWN')) {
        recorder.eventFactionSwitch({ id, previousSide: prev, side: next });
      }
    }
  });


  client.on('playerKilled', (evt) => {
    const killerId = evt?.parsed?.killerId;
    const victimId = evt?.parsed?.victimId;
    const weapon = evt?.parsed?.weapon;
    console.log(`KILL: Killer=${killerId}, Victim=${victimId}, Weapon=${weapon}`);
    if (killerId && victimId) {
      recorder.eventKill({ killerId, victimId, weapon });
    }
  });

  client.on('playerTeamKilled', (evt) => {
    const killerId = evt?.parsed?.killerId;
    const victimId = evt?.parsed?.victimId;
    const weapon = evt?.parsed?.weapon;
    console.log(`TEAM KILL: Killer=${killerId}, Victim=${victimId}, Weapon=${weapon}`);
    if (killerId && victimId) {
      recorder.eventKill({ killerId, victimId, weapon });
    }
  });

  // --- graceful shutdown ---
  const shutdown = async () => {
    console.log('Shuting down...')
    clearInterval(movementTimer);
    await recorder.stop();
    writer.close();
    // try to close sockets gracefully
    client.v2?.socket?.end?.();
    client.v2?.socket?.destroy?.();
    client.v1?.socket?.end?.();
    client.v1?.socket?.destroy?.();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
  });
});
