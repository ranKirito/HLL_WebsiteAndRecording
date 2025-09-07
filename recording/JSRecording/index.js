import { IRCONClient } from 'hll-ircon';
import { Recorder } from './recorder.js';
import { writeRecordingToFile } from './writer.js';
import { promises as fsp } from 'node:fs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from "dotenv";
dotenv.config();
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

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

const CONFIG_PATH = path.resolve(__dirname, '../server-config.json');


async function loadOrAskConfig() {
  let saved = null;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    saved = JSON.parse(raw);
  } catch (_) {
    // no saved config, continue
  }

  const rl = readline.createInterface({ input, output });
  try {
    if (saved && saved.host && saved.port && saved.password) {
      const ans = (await rl.question(`Use saved server ("${saved.host}:${saved.port}")? [Y/n] `)).trim().toLowerCase();
      if (ans === '' || ans === 'y' || ans === 'yes') {
        await rl.close();
        return saved;
      }
    } else {
      console.log('No saved server info detected. Please enter your server info: ')
    }


    const host = (await rl.question(`Enter Host Ip (e.g. 127.0.0.1): `)).trim();
    const portStr = (await rl.question(`Enter Port Number (e.g. 8080): `)).trim();
    const password = (await rl.question(`Enter RCON password: `)).trim();

    const cfg = { host, port: Number(portStr), password };

    const saveAns = (await rl.question('Save these settings to server-config.json for next time? [y/N] ')).trim().toLowerCase();
    if (saveAns === 'y' || saveAns === 'yes') {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      console.log('Saved to', CONFIG_PATH);
    }

    await rl.close();
    return cfg;
  } finally {
    rl.close?.();
  }
}

async function seedInitialState(rec, roster) {
  for (const p of roster) {
    rec.eventConnect({ id: p.iD, name: p.name, side: teamToSide(p.team), role: roleToEnum(p.role), team: p.platoon, loadout: p.loadout, initial: true });
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

(async () => {
  const { host, port, password } = await loadOrAskConfig();

  const client = new IRCONClient({
    host,
    port,
    password,
  });

  client.on('ready', async () => {
    const serverNameRaw = await client.v2.server.getServerName();
    const serverName = printableServerName(serverNameRaw);
    console.log('Logged in to server:', serverName);
    let startTime = Date.now();
    let sessionInfo = await client.v2.session.getSession();
    console.log(`Session started: map=${sessionInfo?.session?.mapName}, players=${sessionInfo?.session?.playerCount ?? 0}`);
    console.log(`Important: ${sessionInfo.session.gameMode}`)
    const newOutPath = () => path.join(OUT_DIR, `match_${new Date().toISOString().replace(/[:.]/g, '-')}.hll`);
    let outFile = newOutPath();
    console.log('Telemetry file will be written on match end to:', outFile);

    // --- initial players snapshot ---
    let previousPlayersInfo = [];
    let recorder = new Recorder({ serverName, map: sessionInfo.session.mapName, tickHz: 2 });

    const logsFileFor = (outfilePath) => {
      if (!outfilePath) return path.join(OUT_DIR, `match_${new Date().toISOString().replace(/[:.]/g, '-')}.logs.txt`);
      if (outfilePath.endsWith('.hll')) return outfilePath.replace(/\.hll$/, '.logs.txt');
      return `${outfilePath}.logs.txt`;
    };

    async function startRecordingForCurrentSession() {
      const initialPlayersResp = await client.v2.players.fetch();
      const playersPlaying = initialPlayersResp?.players ?? [];
      previousPlayersInfo = playersPlaying.slice();
      await seedInitialState(recorder, playersPlaying);
      recorder.start();
    }

    await startRecordingForCurrentSession();

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
              recorder.eventTeamSwitch({ id: p.iD, team: p.platoon });
            }
            if (p.role !== prev.role) {
              console.log(`ROLE SWITCH: Player ${p.iD} from ${roleToEnum(prev.role)} -> ${roleToEnum(p.role)}`);
              recorder.eventRoleSwitch({ id: p.iD, role: roleToEnum(p.role) });
            }
            if (p.loadout !== prev.loadout) {
              console.log(`LOADOUT SWITCH: Player ${p.iD} from ${prev.loadout} -> ${p.loadout}`);
              recorder.eventLoadoutSwitch({ id: p.iD, loadout: p.loadout });
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
      console.log(`CONNECT: Player ${p.iD} (${p.name}) joined as ${roleToEnum(p.role)} on ${teamToSide(p.team)}`);
      recorder.eventConnect({ id: p.iD, name: p.name, side: teamToSide(p.team), role: roleToEnum(p.role), team: p.platoon, loadout: p.loadout });
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
          recorder.eventFactionSwitch({ id, side: next });
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
    async function finalizeToDisk() {
      try {
        const header = recorder.buildHeader({
          matchId: new Date().toISOString().replace(/[:.]/g, '-'),
          mapName: sessionInfo?.session?.mapName ?? 'Unknown',
          startMs: startTime,
          tickHz: 2,
        });
        await writeRecordingToFile({
          schemaPath: path.resolve(__dirname, 'recording.proto'),
          outFile,
          header,
          chunks: recorder.getChunks(),
        });
        console.log('Wrote telemetry:', outFile);
      } catch (err) {
        console.error('Failed to write telemetry file:', err);
      }
    }

    const finalizeAndRestart = async () => {
      console.log('Match ended. Finalizing and restarting recorder...');
      await recorder.stop();
      await finalizeToDisk();
      // write per-match logs file
      try {
        const elapsedMs = Date.now() - startTime;
        const logs = await client.v2.logs.fetch(elapsedMs);
        await fsp.writeFile(logsFileFor(outFile), logs);
        console.log('Wrote logs:', logsFileFor(outFile));
      } catch (e) {
        console.warn('Failed to write match logs:', e);
      }
      // Refresh session, rotate file, reset state
      startTime = Date.now();
      sessionInfo = await client.v2.session.getSession();
      outFile = newOutPath();
      recorder = new Recorder({ serverName, map: sessionInfo.session.mapName, tickHz: 2 });
      await startRecordingForCurrentSession();
      // resume movement polling loop automatically below (it will continue using updated 'recorder')
    };

    const shutdown = async () => {
      console.log('Shuting down...')
      clearInterval(movementTimer);
      await recorder.stop();
      await finalizeToDisk();
      // store per-match logs next to recording
      try {
        const elapsedMs = Date.now() - startTime;
        const logs = await client.v2.logs.fetch(elapsedMs);
        await fsp.writeFile(logsFileFor(outFile), logs);
        console.log('Wrote logs:', logsFileFor(outFile));
      } catch (e) {
        console.warn('Failed to write match logs:', e);
      }
      // try to close sockets gracefully
      client.v2?.socket?.end?.();
      client.v2?.socket?.destroy?.();
      client.v1?.socket?.end?.();
      client.v1?.socket?.destroy?.();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    client.on?.('MATCH ENDED', finalizeAndRestart);
    client.on?.('matchEnded', finalizeAndRestart);
    client.on?.('match_end', finalizeAndRestart);

    process.on('unhandledRejection', (reason) => {
      console.error('Unhandled promise rejection:', reason);
    });
    process.on('uncaughtException', (err) => {
      console.error('Uncaught exception:', err);
    });
  });
})();
