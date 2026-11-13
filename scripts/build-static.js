// Usage: node scripts/build-static.js <unzipped_gtfs_dir> [out.json] [route_id]
// Needs routes.txt, trips.txt, stop_times.txt, stops.txt, shapes.txt from the MTA's "Regular GTFS" subway zip.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const [dir, outFile = 'data/l-line.json', ROUTE = 'L'] = process.argv.slice(2);
if (!dir) {
  console.error('usage: node scripts/build-static.js <gtfs_dir> [out.json] [route_id]');
  process.exit(1);
}

// --- tiny CSV reader (handles quoted fields) ---
function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function* rows(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(dir, file)),
    crlfDelay: Infinity,
  });
  let header = null;
  for await (const raw of rl) {
    const line = raw.replace(/^\uFEFF/, '');
    if (!line) continue;
    const f = splitCsv(line);
    if (!header) { header = f.map((h) => h.trim()); continue; }
    const o = {};
    header.forEach((h, i) => (o[h] = f[i]));
    yield o;
  }
}

// --- geometry: local equirectangular projection (fine at city scale) ---
const R = 6371008.8;
const rad = Math.PI / 180;
const COS0 = Math.cos(40.7 * rad);
const toXY = ([lon, lat]) => [R * lon * rad * COS0, R * lat * rad];

function buildShape(coords) {
  const xy = coords.map(toXY);
  const cum = [0];
  for (let i = 1; i < xy.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  }
  return { coords, xy, cum };
}

// Distance (m) along the shape of the point on it nearest to `ll`.
function project(shape, ll) {
  const [px, py] = toXY(ll);
  let best = { d2: Infinity, dist: 0 };
  for (let i = 0; i < shape.xy.length - 1; i++) {
    const [ax, ay] = shape.xy[i];
    const [bx, by] = shape.xy[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const d2 = (px - cx) ** 2 + (py - cy) ** 2;
    if (d2 < best.d2) best = { d2, dist: shape.cum[i] + t * Math.sqrt(len2) };
  }
  return best.dist;
}

// --- 1. route color ---
let color = '#A7A9AC';
for await (const r of rows('routes.txt')) {
  if (r.route_id === ROUTE && r.route_color) color = `#${r.route_color}`;
}

// --- 2. trips for this route (direction comes from the "..N"/"..S" in the trip id) ---
const trips = new Map();
for await (const t of rows('trips.txt')) {
  if (t.route_id !== ROUTE) continue;
  const dir = (t.trip_id.match(/\.\.([NS])/) ?? [])[1];
  if (dir) trips.set(t.trip_id, { dir, shape: t.shape_id });
}
if (!trips.size) throw new Error(`No trips found for route ${ROUTE}`);

// --- 3. stop sequences; keep the longest trip per direction as the representative ---
const times = new Map();
for await (const s of rows('stop_times.txt')) {
  if (!trips.has(s.trip_id)) continue;
  let arr = times.get(s.trip_id);
  if (!arr) times.set(s.trip_id, (arr = []));
  arr.push({ seq: Number(s.stop_sequence), stop: s.stop_id });
}
const rep = {};
for (const [id, arr] of times) {
  const dir = trips.get(id).dir;
  if (!rep[dir] || arr.length > rep[dir].arr.length) rep[dir] = { id, arr };
}
for (const r of Object.values(rep)) r.arr.sort((a, b) => a.seq - b.seq);

// --- 4. shapes for the representative trips ---
const needShapes = new Set(Object.values(rep).map((r) => trips.get(r.id).shape));
const pts = new Map();
for await (const p of rows('shapes.txt')) {
  if (!needShapes.has(p.shape_id)) continue;
  let arr = pts.get(p.shape_id);
  if (!arr) pts.set(p.shape_id, (arr = []));
  arr.push({ seq: Number(p.shape_pt_sequence), ll: [Number(p.shape_pt_lon), Number(p.shape_pt_lat)] });
}

// --- 5. stop coordinates ---
const needStops = new Set(Object.values(rep).flatMap((r) => r.arr.map((s) => s.stop)));
const stopInfo = new Map();
for await (const s of rows('stops.txt')) {
  if (needStops.has(s.stop_id)) {
    stopInfo.set(s.stop_id, { name: s.stop_name, lon: Number(s.stop_lon), lat: Number(s.stop_lat) });
  }
}

// --- 6. assemble ---
const result = { line: ROUTE, color, shapes: {}, order: {}, stops: {} };
for (const [dir, r] of Object.entries(rep)) {
  const shapePts = pts.get(trips.get(r.id).shape)?.sort((a, b) => a.seq - b.seq).map((p) => p.ll);
  if (!shapePts?.length) throw new Error(`No shape points for direction ${dir}`);
  const shape = buildShape(shapePts);
  result.shapes[dir] = { coords: shape.coords, cum: shape.cum.map((m) => Math.round(m * 10) / 10) };
  result.order[dir] = r.arr.map((s) => s.stop);
  r.arr.forEach((s, i) => {
    const info = stopInfo.get(s.stop);
    if (!info) return;
    result.stops[s.stop] = {
      name: info.name,
      lon: info.lon,
      lat: info.lat,
      dir,
      index: i,
      dist: Math.round(project(shape, [info.lon, info.lat]) * 10) / 10,
    };
  });
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(result));

// --- sanity check: stop distances should rise along each direction ---
for (const [dir, ids] of Object.entries(result.order)) {
  const d = ids.map((id) => result.stops[id]?.dist ?? NaN);
  const monotonic = d.every((v, i) => i === 0 || v >= d[i - 1]);
  console.log(
    `${ROUTE}${dir}: ${ids.length} stops, ${Math.round(result.shapes[dir].cum.at(-1))} m, ` +
      `stop order ${monotonic ? 'OK' : 'NOT monotonic (check shape)'}`
  );
}
console.log(`Wrote ${outFile} (${Math.round(fs.statSync(outFile).size / 1024)} KB)`);
