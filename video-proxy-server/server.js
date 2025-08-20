const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const crypto = require('crypto');
const { promisify } = require('util');
const pipeline = promisify(require('stream').pipeline);

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const METADATA_FILE = path.join(DATA_DIR, 'videos.json');
const INACTIVITY_MINUTES = process.env.INACTIVITY_MINUTES ? Number(process.env.INACTIVITY_MINUTES) : 60;
const CLEANUP_MS = 5 * 60 * 1000; // 5 minutes

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let videos = {};
try {
  if (fs.existsSync(METADATA_FILE)) {
    videos = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8') || '{}');
  }
} catch (e) {
  console.error('Failed to load metadata', e);
  videos = {};
}

function persist() {
  try {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(videos, null, 2));
  } catch (e) {
    console.error('persist error', e);
  }
}

function genId(seed) {
  return crypto.createHash('sha1').update((seed||'') + Date.now().toString()).digest('hex').slice(0, 12);
}

// Background download (full)
async function downloadFull(url, id) {
  try {
    const filePath = path.join(DATA_DIR, id);
    const tmpPath = filePath + '.part';
    const writer = fs.createWriteStream(tmpPath);
    const resp = await axios({ method: 'get', url, responseType: 'stream', timeout: 60000 });
    await pipeline(resp.data, writer);
    fs.renameSync(tmpPath, filePath);
    videos[id].status = 'ready';
    videos[id].path = filePath;
    videos[id].size = fs.statSync(filePath).size;
    videos[id].lastAccess = Date.now();
    persist();
    console.log('Downloaded', id);
  } catch (err) {
    console.error('download error', err && err.message);
    if (videos[id]) {
      videos[id].status = 'error';
      videos[id].error = (err && err.message) || 'download_failed';
      persist();
    }
  }
}

// Cleanup task
setInterval(() => {
  const now = Date.now();
  for (const [id, info] of Object.entries(videos)) {
    if (!info.path) continue;
    const last = info.lastAccess || info.addedAt || 0;
    if (now - last > INACTIVITY_MINUTES * 60 * 1000) {
      try { fs.unlinkSync(info.path); } catch (e) {}
      delete videos[id];
      console.log('Deleted', id);
    }
  }
  persist();
}, CLEANUP_MS);

// Middlewares
app.use(morgan('tiny'));
app.use(express.json());
app.use(rateLimit({ windowMs: 60_000, max: 300 }));

// Serve static assets
app.use('/player', express.static(path.join(__dirname, 'player')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// List videos
app.get('/list', (req, res) => res.json(videos));

// Add remote video to background download. returns id.
app.get('/add', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'missing url' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'invalid url' }); }
  const id = genId(url);
  videos[id] = { id, source: url, status: 'downloading', addedAt: Date.now() };
  persist();
  // start background download without awaiting
  downloadFull(url, id);
  res.json({ id, status: 'downloading' });
});

// Stream cached file with Range support
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

// Stream-proxy: proxy remote file with Range support without saving
app.get('/stream-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'missing url' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'invalid url' }); }
  const headers = {};
  if (req.headers.range) headers.range = req.headers.range;
  try {
    const upstream = await axios({ method: 'get', url, responseType: 'stream', headers, timeout: 60000, validateStatus: null });
    if (upstream.status >= 400) return res.status(502).json({ error: 'upstream ' + upstream.status });
    if (upstream.status === 206) {
      res.status(206);
      const cr = upstream.headers['content-range'];
      if (cr) res.setHeader('Content-Range', cr);
      res.setHeader('Accept-Ranges', upstream.headers['accept-ranges'] || 'bytes');
    } else {
      res.status(200);
    }
    if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
    if (upstream.headers['content-type']) res.setHeader('Content-Type', upstream.headers['content-type']);
    res.setHeader('Cache-Control', 'no-store');
    await pipeline(upstream.data, res);
  } catch (err) {
    console.error('stream-proxy error', err && err.message);
    res.status(502).json({ error: 'stream failed' });
  }
});

// Admin upload (multer) - stores into DATA_DIR and registers metadata
const upload = multer({ dest: DATA_DIR });
app.post('/admin/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const title = req.body.title || 'Untitled';
  const description = req.body.description || '';
  const ext = path.extname(req.file.originalname) || '';
  const id = genId(req.file.originalname + Date.now());
  const finalPath = path.join(DATA_DIR, id + ext);
  try {
    fs.renameSync(req.file.path, finalPath);
    videos[id] = {
      id, title, description, path: finalPath, status: 'ready', addedAt: Date.now(), lastAccess: Date.now()
    };
    persist();
    res.json({ id });
  } catch (e) {
    console.error('upload error', e);
    res.status(500).json({ error: 'save_failed' });
  }
});

// Admin delete
app.post('/admin/delete', express.urlencoded({ extended: false }), (req, res) => {
  const id = req.body.id || req.query.id;
  if (!id) return res.status(400).json({ error: 'missing id' });
  if (!videos[id]) return res.status(404).json({ error: 'not found' });
  try {
    if (videos[id].path && fs.existsSync(videos[id].path)) fs.unlinkSync(videos[id].path);
  } catch (e) {}
  delete videos[id];
  persist();
  res.json({ ok: true });
});

// Watch page
app.get(['/watch/:id', '/watch/:id/'], (req, res) => {
  const id = req.params.id;
  let source = null;
  if (id === 'temp') {
    if (!req.query.url) return res.status(400).send('Missing url for temp watch');
    source = '/stream-proxy?url=' + encodeURIComponent(req.query.url);
  } else {
    const info = videos[id];
    if (!info) return res.status(404).send('Unknown id');
    source = info.path ? '/stream/' + id : '/stream-proxy?url=' + encodeURIComponent(info.source || '');
  }
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Watch ${id}</title><link rel="stylesheet" href="/player/player.css"></head><body><div class="player-wrap"><h2>Playing ${id}</h2><video id="v" controls crossorigin playsinline><source src="${source}" type="video/mp4">Your browser does not support HTML5 video.</video></div><script>if('serviceWorker' in navigator){navigator.serviceWorker.register('/player/sw.js').catch(e=>console.warn('sw',e));}</script></body></html>`);
});

// Serve admin and player static files (already by express.static middleware)
// Start server
app.listen(PORT, () => {
  console.log('Server listening on', PORT);
  persist();
});
