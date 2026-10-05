/**
 * Shared domain types for Party Radar Mobile.
 * Everything is plain JSON-serializable so it can fly over Supabase Realtime Broadcast.
 * (Ported 1:1 from the Party Radar web app so both clients stay interoperable.)
 */

export interface Coordinates {
  lat: number;
  lng: number;
}

/** A single squad member as seen by everyone in the room. */
export interface PartyMember {
  /** Unique per device/session (randomUUID). */
  id: string;
  /** Display name chosen at join time. */
  name: string;
  /** Hex marker color, e.g. "#22d3ee". */
  color: string;
  position: Coordinates;
  /** Compass heading in degrees (0 = north, clockwise). Null when the device has no compass. */
  heading: number | null;
  /** Speed in m/s from the location API. Null when unavailable. */
  speed: number | null;
  /** GPS accuracy radius in meters. Null when unavailable. */
  accuracy: number | null;
  /** Battery level 0..1. Null when the Battery API is unsupported. */
  battery: number | null;
  /** Epoch ms of the last broadcast received (or produced, for the local player). */
  lastUpdated: number;
}

/** A temporary waypoint dropped by long-pressing the map. */
export interface WaypointPing {
  id: string;
  lat: number;
  lng: number;
  createdById: string;
  createdByName: string;
  /** Marker color of the player who dropped it. */
  color: string;
  createdAt: number;
  /** Epoch ms after which the ping disappears for everyone. */
  expiresAt: number;
}

/** Payload of the `member-update` broadcast event. */
export interface MemberUpdatePayload {
  id: string;
  name: string;
  color: string;
  lat: number;
  lng: number;
  heading: number | null;
  speed: number | null;
  battery: number | null;
  ts: number;
}

/** Payload of the `ping` broadcast event. */
export interface PingPayload {
  ping: WaypointPing;
}

/** Payload of the `ping-remove` broadcast event (removes a ping for everyone). */
export interface PingRemovePayload {
  id: string;
}

/** Travel profile for routing (OSRM). */
export type RouteProfile = 'foot' | 'driving';

/** A computed route from the local player to a destination. */
export interface RouteInfo {
  id: string;
  profile: RouteProfile;
  /** Human label, e.g. "PING by Sam" or "MEETUP POINT". */
  label: string;
  dest: Coordinates;
  distanceM: number;
  durationS: number;
  /** Route geometry as [lat, lng] pairs. */
  polyline: [number, number][];
  createdAt: number;
  createdById: string;
}

/** A shared meetup point proposed to the whole party. */
export interface MeetupPoint {
  id: string;
  lat: number;
  lng: number;
  label: string;
  createdById: string;
  createdByName: string;
  createdAt: number;
}

/** Payload of the `meetup-share` broadcast event. */
export interface MeetupSharePayload {
  meetup: MeetupPoint;
}

/** Payload of the `meetup-clear` broadcast event. */
export interface MeetupClearPayload {
  id: string;
}

export type MemberStatus = 'moving' | 'idle' | 'stale';

/** How long a waypoint ping stays visible for the whole party. */
export const PING_TTL_MS = 60_000;

/** A member with no update for this long is rendered dimmed / "STALE". */
export const STALE_AFTER_MS = 20_000;

export const MEMBER_COLORS = ['#22d3ee', '#f472b6', '#a3e635', '#fb923c'] as const;

export function memberStatus(m: PartyMember, now: number = Date.now()): MemberStatus {
  if (now - m.lastUpdated > STALE_AFTER_MS) return 'stale';
  return (m.speed ?? 0) > 0.8 ? 'moving' : 'idle';
}
