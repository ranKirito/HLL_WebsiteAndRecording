# Repository Guidelines

## Project Structure & Modules
- `JSRecording/`: Node.js telemetry tools
  - `index.js`: connects to HLL RCON and records a match
  - `recorder.js`: event/movement chunking and flush cadence
  - `writer.js`: protobuf writer using `recording.proto`
  - `reader.js`: decoder/CLI to inspect `.hll` files
  - `recording.proto`: telemetry schema
- `out/`: generated recordings (e.g., `match_<timestamp>.hll`)
- `server-config.json`: local RCON settings; contains secrets
- `package.json`: scripts and deps; ESM (`"type": "module"`)
- `tsconfig.json`: TS options (project currently JS).

## Build, Test, and Dev Commands
- Install: `npm ci`
- Run recorder: `npm start`
  - Prompts for host/port/password (or uses `server-config.json`) and writes to `out/`.
- Decode/inspect: `node JSRecording/reader.js out/<file>.hll --out decoded.json --pos-csv pos.csv --events-csv events.csv`
- Tests: none yet. Validate manually by recording a short session, then decoding with `reader.js`.

## Coding Style & Naming
- Language: modern Node.js ESM. Target Node 18+.
- Indentation: 2 spaces; use semicolons; prefer named exports.
- Filenames: lowerCamel for modules (`recorder.js`), SCREAMING_SNAKE for constants.
- Keep functions small; avoid side effects; log succinctly.

## Testing Guidelines
- Framework: not configured. For new logic, add minimal CLI checks or lightweight unit tests under `JSRecording/__tests__/` (Jest/Vitest acceptable) and document how to run.
- Provide sample input/output or a decoded snippet in PRs.

## Commit & Pull Request Guidelines
- Commits: use Conventional Commits (e.g., `feat:`, `fix:`, `refactor:`, `chore:`). Group related changes.
- PRs: include purpose, summary of changes, how you tested (commands run), and sample output paths (e.g., `out/match_*.hll`, `decoded.json`). Link issues if applicable.

## Security & Configuration
- Do NOT commit real credentials. `server-config.json` is for local use; scrub before committing or add to `.gitignore` if personal.
- `dotenv` is available; prefer environment variables for secrets when scripting.

## Architecture Overview
IRCON client -> `Recorder` batches events/positions -> `TelemetryWriter` encodes via protobuf -> `.hll` file in `out/`. Use `reader.js` to validate and export JSON/CSV.

