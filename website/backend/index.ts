import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import protobuf from 'protobufjs';
import { insertReplay, listReplays, getReplayById } from './db.js';
import type { Request, Response } from 'express';


const app = express();
const PORT = 4000;
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());

// Load protobuf definition
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const protoPath = path.join(__dirname, 'record.proto');
let RecordMessage: protobuf.Type;

protobuf.load(protoPath, (err, root) => {
    if (err || !root) {
    throw err ?? new Error('Failed to load protobuf root');
  }
  RecordMessage = root.lookupType('record.MatchData'); // replace 'main.Record' if your proto uses another namespace
});

// Upload route
app.post('/upload', upload.single('replay'), (req: Request, res: Response):void => {
  const file = req.file;
  if (!file || !file.originalname.endsWith('.hll')) {
    res.status(400).json({ error: 'Invalid file' });
    return;
  }

  const buffer = fs.readFileSync(file.path);
  let decoded;
  try {
    decoded = RecordMessage.decode(buffer);
  } catch (e) {
    res.status(500).json({ error: 'Failed to parse .hll file' });
    return;
  }

  const replayData = RecordMessage.toObject(decoded, {
    enums: String,
    longs: Number,
    defaults: true,
    arrays: true,
    objects: true,
  });

  console.log(replayData)
  const matchDuration = (replayData.header.endTime.seconds - replayData.header.startTime.seconds) / 60
  const metadata = {
    id: file.filename,
    filename: file.path,
    originalname: file.originalname,
    map: replayData.header.mapId || 'Unknown',
    duration: matchDuration || 0,
    created_at: new Date().toISOString(),
  };

  console.log("metadata: ", metadata);

  insertReplay(metadata);

  res.json({ success: true, id: metadata.id });
});

// List route
app.get('/list', (req, res) => {
  console.log("endopoint hit")
  res.json(listReplays());
});

// Download route
app.get('/replay/:id', (req, res) => {
  const id = req.params.id;
  res.sendFile(path.join(__dirname, `/uploads/${id}`))
});

app.listen(PORT, () => {
  console.log("Backend starting...");
  console.log(`Backend running at http://localhost:${PORT}`);
});
