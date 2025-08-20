import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { PassThrough } from 'stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const INACTIVITY_MS = (process.env.INACTIVITY_MINUTES ? Number(process.env.INACTIVITY_MINUTES) : 60) * 60 * 1000;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const METADATA_FILE = path.join(DATA_DIR, 'videos.json');
let videos = {};
try {
  videos = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8') || '{}');
} catch (e) {
  videos = {};
}

function persist() {
  fs.writeFileSync(METADATA_FILE, JSON.stringify(videos, null, 2));
}

function genId(url) {
  return crypto.createHash('sha1').update(url + Date.now().toString()).digest('hex').slice(0, 12);
}

async function downloadFull(url, id) {
  try {
    const filePath = path.join(DATA_DIR, id);
    const tmpPath = filePath + '.part';
    const res = await fetch(url);
    if (!res.ok) {
      videos[id].status = 'error';
      videos[id].error = 'fetch_failed_' + res.status;
      persist();
      return;
    }
    const dest = fs.createWriteStream(tmpPath);
    await pipeline(res.body, dest);
    fs.renameSync(tmpPath, filePath);
    videos[id].status = 'ready';
    videos[id].size = fs.statSync(filePath).size;
    videos[id].path = filePath;
    videos[id].lastAccess = Date.now();
    persist();
    console.log('Downloaded', id);
  } catch (err) {
    console.error('downloadFull error', err);
    videos[id].status = 'error';
    videos[id].error = String(err);
    persist();
  }
}

function scheduleCleanup() {
  setInterval(() => {
    const now = Date.now();
    for (const [id, info] of Object.entries(videos)) {
      if (!info.path) continue;
      const last = info.lastAccess || info.addedAt || 0;
      if (now - last > INACTIVITY_MS) {
        try {
          fs.unlinkSync(info.path);
        } catch (e) {}
        delete videos[id];
        console.log('Deleted', id);
      }
    }
    persist();
  }, CLEANUP_INTERVAL_MS);
}

const app = express();
app.use(helmet());
app.use(morgan('tiny'));
app.use(express.json());
app.use(rateLimit({ windowMs: 60_000, max: 300 }));

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// Add a video to be downloaded and cached. Returns ID immediately.
app.get('/add', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'missing url' });
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'invalid url' });
  }
  const id = genId(url);
  videos[id] = {
    id, source: url, status: 'downloading', addedAt: Date.now()
  };
  persist();
  // start background download
  downloadFull(url, id);
  res.json({ id, status: 'downloading' });
});

// Watch page for a video. If id equals 'temp' then a direct source URL must be provided via query.
app.get(['/watch/:id', '/watch/:id/'], (req, res) => {
  const id = req.params.id;
  let source = null;
  if (id === 'temp') {
    if (!req.query.url) return res.status(400).send('Missing url for temp watch');
    source = req.query.url;
  } else {
    const info = videos[id];
    if (!info) return res.status(404).send('Unknown id');
    source = info.path ? '/stream/' + id : info.source;
  }

  // Serve a simple watch page with our player
  res.type('html').send(`<!doctype html>
  <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Watch - ${id}</title>
  <link rel="stylesheet" href="/player/player.css">
  </head><body>
  <div class="player-wrap">
    <h2>Playing ${id}</h2>
    <video id="v" controls crossorigin playsinline>
      <source src="${source.startsWith('/') ? source : '/stream-proxy?url=' + encodeURIComponent(source)}" type="video/mp4">
      Your browser does not support HTML5 video.
    </video>
  </div>
  <script>
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/player/sw.js').catch(e=>console.warn('sw',e));
    }
  </script>
  </body></html>`);
});

// Stream endpoint that serves local file with range support if present, otherwise 404.
app.get('/stream/:id', (req, res) => {
  const id = req.params.id;
  const info = videos[id];
  if (!info || !info.path || !fs.existsSync(info.path)) {
    return res.status(404).json({ error: 'not cached' });
  }
  const filePath = info.path;
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const range = req.headers.range;
  info.lastAccess = Date.now();
  persist();

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    if (isNaN(start) || isNaN(end) || start > end) return res.status(416).send('Requested Range Not Satisfiable');
    const chunkSize = (end - start) + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(chunkSize),
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store'
    });
    const stream = fs.createReadStream(filePath, { start, end });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': String(total),
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  }
});

// Proxy-stream: streams from remote (with range support) but does NOT save full file.
// Use this for temp play when no cached copy exists.
app.get('/stream-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'missing url' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'invalid url' }); }
  const headers = {};
  if (req.headers.range) headers.range = req.headers.range;
  try {
    const upstream = await fetch(url, { headers });
    if (!upstream.ok) return res.status(502).json({ error: 'upstream ' + upstream.status });
    // pass through status and headers (some)
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentLength = upstream.headers.get('content-length');
    if (upstream.status === 206) {
      res.status(206);
      if (upstream.headers.get('content-range')) res.setHeader('Content-Range', upstream.headers.get('content-range'));
      res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
    } else {
      res.status(200);
    }
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');

    // stream to client
    const body = upstream.body;
    await pipeline(body, res);
  } catch (err) {
    console.error('stream-proxy error', err);
    res.status(502).json({ error: 'stream failed' });
  }
});

// Serve static player and sw
app.use('/player', express.static(path.join(__dirname, '..', 'player')));

// Simple listing for debug
app.get('/list', (req, res) => res.json(videos));

scheduleCleanup();

app.listen(PORT, () => {
  console.log('Mainframe server listening on', PORT);
});
