import { IRCONClient } from 'hll-ircon';
import { Recorder } from './recorder.js';
import { TelemetryWriter } from './writer.js';

// --- helpers to map library values to recorder-friendly enums/strings ---
const sideFromFactionString = (s) => {
  if (s === 'Allies') return 'ALLIES';
  if (s === 'Axis') return 'AXIS';
  return 'SIDE_UNKNOWN'; // 'None' or anything else
};
// TODO: map numeric role -> enum string you use in your .proto (placeholder for now)
const roleToEnum = (n) => 'ROLE_UNKNOWN';
// TODO: check if playerIDs corelate to steamUIDS

const teamToSide = (t) => (t === 1 ? 'ALLIES' : t === 0 ? 'AXIS' : 'SIDE_UNKNOWN');

// Extract a printable server name regardless of object/string shape
const printableServerName = (serverName) => {
  if (serverName && typeof serverName === 'object') {
    return serverName.Value || serverName.name || JSON.stringify(serverName);
  }
  return serverName;
};

// Seed initial roster into the recorder (synthetic CONNECT + initial position)
async function seedInitialState(rec, roster) {
  for (const p of roster) {
    rec.eventConnect({ id: p.iD, side: teamToSide(p.team), role: roleToEnum(p.role) });
    if (p.worldPosition) {
      rec.sampleMovement({
        id: p.iD,
        x: p.worldPosition.x,
        y: p.worldPosition.y,
      });
    }
  }
  rec.flush(); // write an initial chunk immediately
}

const client = new IRCONClient({
  host: '85.208.197.66',
  port: '7819',
  password: '7if4w',
});

client.on('ready', async () => {
  // --- server + session info ---
  const serverNameRaw = await client.v2.server.getServerName();
  const serverName = printableServerName(serverNameRaw);
  console.log('Logged in to server:', serverName);

  const sessionInfo = await client.v2.session.getSession();
  console.log('Session information:', sessionInfo);

  // --- open protobuf writer & header ---
  const writer = new TelemetryWriter({
    schemaPath: './recording.proto',
    // place outputs one directory up from JSRecording into ./out/
    outFile: `../out/match_${new Date().toISOString().replace(/[:.]/g, '-')}.pb`,
  });
  await writer.init({
    match_id: new Date().toISOString().replace(/[:.]/g, '-'),
    map_name: sessionInfo?.session?.mapName ?? 'Unknown',
    start_ms: Date.now(),
    tick_hz: 2,
    // TODO: replace these with real map bounds
    min_x: -5000,
    max_x: 5000,
    min_y: -5000,
    max_y: 5000,
  });

  // --- initial players snapshot ---
  const playersPlaying = await client.v2.players.fetch(); // array of Player objects
  console.log('Players currently playing:', playersPlaying.length);

  let previousPlayersInfo = await client.v2.players.fetch();
  // --- initialize recorder (provide map bounds + flush handler) ---
  // TODO: replace bounds with actual map extent if you have it
  const recorder = new Recorder({
    serverName,
    map: sessionInfo.session.mapName,
    bounds: { minX: -5000, maxX: 5000, minY: -5000, maxY: 5000 },
    tickHz: 2,
    onFlush: (chunk) => {
      writer.writeChunk(chunk);
    },
  });

  // Seed initial roster so mid-match players appear immediately
  await seedInitialState(recorder, playersPlaying);
  recorder.start();

  // --- movement sampler: poll positions every second and record if changed ---
  const movementTimer = setInterval(async () => {
    try {
      const cur = await client.v2.players.fetch();
      const prevById = new Map(previousPlayersInfo.map(pp => [pp.iD, pp]));
      for (const p of cur) {
        if (!p.worldPosition) continue;
        recorder.sampleMovement({
          id: p.iD,
          x: p.worldPosition.x,
          y: p.worldPosition.y,
        });
        // not available in the parser of the client so this is the easiest way to do it
        const prev = prevById.get(p.iD);
        if (prev) {
          if (p.team !== prev.team) {
            recorder.eventTeamSwitch({
              id: p.iD,
              previousTeam: prev.team,
              team: p.team,
            });
          }
          if (p.role !== prev.role) {
            recorder.eventRoleSwitch({
              id: p.iD,
              previousRole: prev.role,
              role: p.role,
            });
          }
          if (p.loadout !== prev.loadout) {
            recorder.eventLoadoutSwitch({
              id: p.iD,
              previousLoadout: prev.loadout,
              loadout: p.loadout,
            });
          }
        }
      }
      //refresh prev players

      previousPlayersInfo = cur;
    } catch (e) {
      console.error('movement poll failed:', e);
    }
  }, 1000);

  // --- example event hooks (adjust to actual event names/payloads emitted by the lib) ---
  client.on('playerConnected', async (evt) => {
    // If the event only has an ID, fetch the player object; otherwise map directly
    const p = evt?.player || (await client.v2.players.get?.(evt?.parsed?.playerId));
    if (!p) return;
    recorder.eventConnect({ id: p.iD, side: teamToSide(p.team), role: roleToEnum(p.role) });
  });

  client.on('playerDisconnected', (evt) => {
    const id = evt?.parsed?.playerId || evt?.player?.iD;
    if (id) recorder.eventDisconnect({ id });
  });

  client.on('playerSwitchFaction', (evt) => {
    const id = evt?.parsed?.playerId || evt?.player?.iD;
    const prev = sideFromFactionString(evt?.parsed?.oldFaction);
    const next = sideFromFactionString(evt?.parsed?.newFaction);
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
    if (killerId && victimId) {
      recorder.eventKill({ killerId, victimId, weapon });
    }
  });

  client.on('playerTeamKilled', (evt) => {
    const killerId = evt?.parsed?.killerId;
    const victimId = evt?.parsed?.victimId;
    const weapon = evt?.parsed?.weapon;
    if (killerId && victimId) {
      recorder.eventKill({ killerId, victimId, weapon });
    }
  });

  // --- graceful shutdown ---
  const shutdown = async () => {
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
});
