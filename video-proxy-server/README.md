# Video Proxy Server (Render-ready)

This repo contains a Render-friendly Node.js mainframe server that can:
- Accept file uploads via `/admin/upload`
- Prefetch remote video files via `/add?url=` (background download)
- Serve watched videos at `/watch/:id` using `/stream/:id`
- Proxy remote streams via `/stream-proxy?url=` (with Range support)
- Auto-cleanup files after inactivity (configurable)

## Quick start (locally)
```bash
npm install
npm start
```
Server listens on `process.env.PORT || 4000`.
Files are stored under `DATA_DIR` (default `./data`).

## Deploy to Render.com
1. Push this repo to GitHub.
2. Create a new Web Service in Render and connect the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. (Optional) Set environment variable `DATA_DIR=/opt/render/data`

Make sure `package.json` is at the repository root (it is).
