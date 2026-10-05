/**
 * Routing client — free, keyless, open-data.
 *
 * Uses the public OSRM demo server (OpenStreetMap routing, no signup, no API
 * key). It's rate-limited and has no SLA, so this module layers protections:
 *
 *  - Short client-side cache (rounded coordinates) so repeat taps are free.
 *  - Typed errors so the UI can degrade to a straight "crow-flies" line
 *    instead of showing a raw failure.
 *
 * If the demo server ever becomes a bottleneck, swap `OSRM_BASE` for a
 * self-hosted OSRM/Valhalla instance or an OpenRouteService key — the
 * `fetchRoute` signature stays the same.
 *
 * (Ported 1:1 from the Party Radar web app; `fetch` is global in React Native.)
 */
import type { Coordinates, RouteProfile } from '@/types/party';

const OSRM_BASE = 'https://router.project-osrm.org/route/v1';
/** Cached routes stay valid this long (positions drift, roads don't). */
const CACHE_TTL_MS = 3 * 60_000;
const CACHE_MAX = 50;

export interface RouteResult {
  distanceM: number;
  durationS: number;
  /** [lat, lng] pairs of the route geometry. */
  polyline: [number, number][];
}

export type RouteErrorKind = 'rate-limited' | 'no-route' | 'network' | 'server';

export class RouteError extends Error {
  kind: RouteErrorKind;
  constructor(kind: RouteErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

interface CacheEntry {
  at: number;
  data: RouteResult;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(origin: Coordinates, dest: Coordinates, profile: RouteProfile): string {
  const r = (n: number) => n.toFixed(4); // ~11 m — absorbs GPS jitter
  return `${profile}|${r(origin.lat)},${r(origin.lng)}|${r(dest.lat)},${r(dest.lng)}`;
}

function pruneCache(now: number): void {
  cache.forEach((v, k) => {
    if (now - v.at > CACHE_TTL_MS) cache.delete(k);
  });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

interface OsrmResponse {
  code: string;
  routes?: Array<{
    distance: number;
    duration: number;
    geometry?: { coordinates: [number, number][] };
  }>;
}

/**
 * Fetch a route from origin to dest. Never throws raw network errors —
 * everything surfaces as a RouteError with a kind the UI can explain.
 */
export async function fetchRoute(
  origin: Coordinates,
  dest: Coordinates,
  profile: RouteProfile,
): Promise<RouteResult> {
  const now = Date.now();
  pruneCache(now);
  const key = cacheKey(origin, dest, profile);
  const hit = cache.get(key);
  if (hit && now - hit.at <= CACHE_TTL_MS) return hit.data;

  // OSRM wants lng,lat order.
  const url =
    `${OSRM_BASE}/${profile}/${origin.lng},${origin.lat};${dest.lng},${dest.lat}` +
    `?overview=full&geometries=geojson`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new RouteError('network', "Couldn't reach the route service.");
  }

  if (res.status === 429) {
    throw new RouteError('rate-limited', 'Route service is busy right now.');
  }
  if (!res.ok) {
    throw new RouteError('server', 'Route service had a hiccup.');
  }

  let body: OsrmResponse;
  try {
    body = (await res.json()) as OsrmResponse;
  } catch {
    throw new RouteError('server', 'Route service returned garbage.');
  }

  const route = body.code === 'Ok' ? body.routes?.[0] : undefined;
  if (!route || !route.geometry) {
    throw new RouteError('no-route', 'No route found for this profile.');
  }

  const result: RouteResult = {
    distanceM: route.distance,
    durationS: route.duration,
    polyline: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
  };
  cache.set(key, { at: now, data: result });
  return result;
}

/** Human explanation for a routing failure, for the fallback banner. */
export function routeErrorNotice(kind: RouteErrorKind, profile: RouteProfile): string {
  const mode = profile === 'foot' ? 'walking' : 'driving';
  switch (kind) {
    case 'rate-limited':
      return 'Route service is busy — showing straight-line path.';
    case 'network':
      return "You're offline — showing straight-line path.";
    case 'no-route':
      return `No ${mode} route found — showing straight-line path.`;
    case 'server':
      return 'Route service hiccup — showing straight-line path.';
  }
}
