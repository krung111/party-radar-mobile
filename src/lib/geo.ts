/**
 * Great-circle math used by Party Radar Mobile.
 * All angles in degrees, all distances in meters.
 * (Ported 1:1 from the Party Radar web app.)
 */
import type { Coordinates } from '@/types/party';

export const EARTH_RADIUS_M = 6_371_000;

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Normalize any angle to [0, 360). */
export function normalize360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Signed smallest difference from a to b, in (-180, 180]. */
export function angleDiff(a: number, b: number): number {
  const d = normalize360(b - a);
  return d > 180 ? d - 360 : d;
}

/** Interpolate from angle a toward angle b (shortest path), t in [0,1]. */
export function lerpAngle(a: number, b: number, t: number): number {
  return normalize360(a + angleDiff(a, b) * t);
}

/** Haversine distance between two coordinates, in meters. */
export function haversineMeters(from: Coordinates, to: Coordinates): number {
  const dLat = toRadians(to.lat - from.lat);
  const dLng = toRadians(to.lng - from.lng);
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Initial bearing from `from` to `to`, in degrees clockwise from true north.
 */
export function bearingDegrees(from: Coordinates, to: Coordinates): number {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const dLng = toRadians(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return normalize360(toDegrees(Math.atan2(y, x)));
}

/**
 * Destination point given a start, a bearing (deg clockwise from north)
 * and a distance in meters.
 */
export function destinationPoint(
  from: Coordinates,
  bearingDeg: number,
  distanceM: number,
): Coordinates {
  const d = distanceM / EARTH_RADIUS_M;
  const br = toRadians(bearingDeg);
  const lat1 = toRadians(from.lat);
  const lng1 = toRadians(from.lng);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );

  return { lat: toDegrees(lat2), lng: normalize360(toDegrees(lng2) + 180) - 180 };
}

/** Human-friendly distance: "54 m", "1.2 km", "12 km". */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '—';
  if (meters < 1000) return `${Math.round(meters)} m`;
  if (meters < 10000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000)} km`;
}

/** Human-friendly duration: "45 s", "12 min", "1 h 5 min". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}
