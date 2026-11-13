import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { transit_realtime } = GtfsRealtimeBindings;

// Confirm this URL against the MTA developer page (mta.info/developers) before relying on it.
export const FEED_URL =
  process.env.MTA_FEED_URL ??
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l';

// protobufjs may hand back Long objects for 64-bit fields; normalize to plain numbers.
const num = (v) =>
  v == null ? null : typeof v === 'number' ? v : typeof v.toNumber === 'function' ? v.toNumber() : Number(v);

export async function fetchFeed(url = FEED_URL) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`MTA feed returned HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return transit_realtime.FeedMessage.decode(bytes);
}

// MTA stop IDs end in N or S (their direction labels, not literal compass headings).
const dirOf = (stopId) => (stopId?.endsWith('N') ? 'N' : stopId?.endsWith('S') ? 'S' : '?');

/**
 * Turn a decoded FeedMessage into a flat list of active trains:
 * { id, line, dir, hasVehicle, stopped, lastStop, nextStop, terminus }
 * where lastStop/nextStop are { stopId, t } with t in epoch seconds.
 */
export function normalize(feed, nowSec = Math.floor(Date.now() / 1000)) {
  const vehicles = new Map();
  for (const e of feed.entity) {
    const tripId = e.vehicle?.trip?.tripId;
    if (tripId) vehicles.set(tripId, e.vehicle);
  }

  const trains = [];
  for (const e of feed.entity) {
    const tu = e.tripUpdate;
    const tripId = tu?.trip?.tripId;
    if (!tripId) continue;

    const stops = (tu.stopTimeUpdate ?? [])
      .map((s) => ({ stopId: s.stopId, t: num(s.arrival?.time) ?? num(s.departure?.time) }))
      .filter((s) => s.stopId && s.t);
    if (!stops.length) continue;

    const nextIdx = stops.findIndex((s) => s.t >= nowSec);
    if (nextIdx === -1) continue; // trip has finished

    const v = vehicles.get(tripId);
    const next = stops[nextIdx];
    const last = nextIdx > 0 ? stops[nextIdx - 1] : null;

    trains.push({
      id: tripId,
      line: tu.trip.routeId || 'L',
      dir: dirOf(next.stopId),
      hasVehicle: Boolean(v), // false = scheduled but not yet reported as running
      stopped: v?.currentStatus === 1, // GTFS-RT STOPPED_AT
      lastStop: last,
      nextStop: next,
      terminus: stops[stops.length - 1].stopId,
    });
  }
  return trains;
}