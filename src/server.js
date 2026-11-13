import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { fetchFeed, normalize } from './decoder.js';

const PORT = Number(process.env.PORT ?? 8080);
const POLL_MS = Number(process.env.POLL_MS ?? 20_000);
const MAX_BACKOFF_MS = 120_000;

// Serves public/ (the page) and data/ (l-line.json) from the project root, nothing else.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  } catch {
    return res.writeHead(400).end();
  }
  const rel = urlPath === '/' ? 'public/index.html' : urlPath.startsWith('/data/') ? urlPath.slice(1) : `public${urlPath}`;
  const file = path.resolve(ROOT, rel);
  const allowed = [path.join(ROOT, 'public') + path.sep, path.join(ROOT, 'data') + path.sep];
  if (!allowed.some((dir) => file.startsWith(dir))) return res.writeHead(404).end();

  fs.readFile(file, (err, buf) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

let trains = new Map(); // tripId -> train
let updatedAt = null;
let failures = 0;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: failures < 3, trains: trains.size, updatedAt, failures }));
  }
  if (req.url === '/api/trains') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ updatedAt, trains: [...trains.values()] }));
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server });

// Full state for anyone who connects; deltas after that.
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.send(JSON.stringify({ type: 'snapshot', updatedAt, serverNow: Date.now(), trains: [...trains.values()] }));
});

// Drop dead connections.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === 1) client.send(data);
}

async function poll() {
  try {
    const next = new Map(normalize(await fetchFeed()).map((t) => [t.id, t]));

    const upsert = [];
    for (const [id, t] of next) {
      const prev = trains.get(id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(t)) upsert.push(t);
    }
    const remove = [...trains.keys()].filter((id) => !next.has(id));

    trains = next;
    updatedAt = Date.now();
    failures = 0;

    if (upsert.length || remove.length) broadcast({ type: 'delta', updatedAt, serverNow: Date.now(), upsert, remove });
    console.log(
      `[${new Date().toISOString()}] trains=${next.size} +${upsert.length} -${remove.length} clients=${wss.clients.size}`
    );
  } catch (err) {
    failures++;
    console.error(`[poll] failed (${failures}):`, err.message);
  }
  const delay = Math.min(POLL_MS * 2 ** Math.min(failures, 4), MAX_BACKOFF_MS);
  setTimeout(poll, delay);
}

server.listen(PORT, () => {
  console.log(`NYC Pulse server on :${PORT} (poll every ${POLL_MS / 1000}s)`);
  poll();
});
