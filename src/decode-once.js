import { fetchFeed, normalize, FEED_URL } from './decoder.js';

const showRaw = process.argv.includes('--raw');

const feed = await fetchFeed();
const headerTs = Number(feed.header?.timestamp?.toString?.() ?? feed.header?.timestamp);
console.log(`Feed: ${FEED_URL}`);
console.log(`Header time: ${new Date(headerTs * 1000).toISOString()}  entities: ${feed.entity.length}`);

if (showRaw) {
  // Inspect real field shapes (including any NYCT extensions) before trusting the normalizer.
  const sample = feed.entity.find((e) => e.tripUpdate) ?? feed.entity[0];
  console.log(JSON.stringify(sample, null, 2));
}

const now = Math.floor(Date.now() / 1000);
const rows = normalize(feed, now)
  .sort((a, b) => a.nextStop.t - b.nextStop.t)
  .map((t) => ({
    trip: t.id,
    dir: t.dir,
    running: t.hasVehicle,
    stopped: t.stopped,
    last: t.lastStop?.stopId ?? '-',
    next: t.nextStop.stopId,
    'eta (s)': t.nextStop.t - now,
    to: t.terminus,
  }));

console.table(rows);
console.log(`${rows.length} active trips`);