Video Proxy / Mainframe - Ready to Deploy
=======================================

Structure
---------
- main_site/         -> Static directory for your "directory" UI (drop this on any static host or same server)
- player/            -> Player assets and service worker
- mainframe_server/  -> Node.js server that downloads and serves video files (runs on port 4000 by default)

Quick start (server)
---------------------
1. Copy the `mainframe_server` folder to your server.
2. Install dependencies and start:
   ```bash
   cd mainframe_server
   npm install
   npm start
   ```
   Ensure Node 18+ is installed.

3. By default the server stores data under `mainframe_server/data`. You can change via the DATA_DIR environment variable.

How it works
------------
- `GET /add?url=...` -> queues a background full download of the remote file and returns an `id`.
- `GET /watch/:id` -> serves the watch page. If `id` is 'temp' you can pass `?url=` to watch without prefetch.
- `GET /stream/:id` -> streams the cached local file with Range support (used by the player).
- `GET /stream-proxy?url=` -> proxies remote stream with Range support without caching (useful for temp play).
- Files are auto-deleted after `INACTIVITY_MINUTES` (default 60) of not being accessed.

Cloudflare / DNS guide
----------------------
1. Create a DNS A record for `mainframe.yourdomain.com` pointing to your server IP.
2. You can enable or disable Cloudflare proxying (orange cloud). For streaming, you may want to disable proxying (gray cloud) to avoid Cloudflare buffering and to allow range requests to pass through cleanly. If you enable the proxy, set up rules to bypass cache for `/stream` and `/stream-proxy`.
3. Add Firewall rules to protect `/add` endpoint from abuse (or use authentication).
4. For TLS: use Full (strict) if you have certs on the origin, or Flexible if not (not recommended). Best is to install a TLS cert on your server and set Cloudflare to Full (strict).

Security & Notes
----------------
- This project is a demo. Add authentication and stricter host whitelisting before public deployment.
- Respect copyright and terms-of-service of content sources.
- Test with small sample files before scaling.

