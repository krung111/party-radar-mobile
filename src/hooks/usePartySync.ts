/**
 * Joins a party room over Supabase Realtime and keeps the squad in sync.
 *
 *  - Broadcast `member-update`: throttled position/heading/battery blips
 *    (on move, on turn, plus a heartbeat). 2–4 players × ~0.5 msg/s is far
 *    below the free-tier Realtime limits.
 *  - Broadcast `ping` / `ping-remove`: waypoint pings, rendered by everyone
 *    with a countdown. The creator can tap their own pin to remove it for all.
 *  - Broadcast `meetup-share` / `meetup-clear`: shared midpoint meetups.
 *  - Presence: join/leave roster. Members missing from presence are removed,
 *    but only after a grace period — a presence `sync` racing a delayed
 *    broadcast must not flicker people out of the UI. Broadcasts from ids
 *    not (yet) in presence are stashed until presence confirms them, so
 *    spoofed ghosts never render.
 *  - Join dedupe: callsign + marker color are made unique against the members
 *    already present when you subscribe.
 *  - Foreground resync: returning from the background forces a fresh GPS fix,
 *    an immediate broadcast, and a presence re-track.
 *  - Routing: on-demand OSRM routes (route to pin / member / meetup point)
 *    with client-side caching, request throttling, and a straight-line
 *    "crow-flies" fallback when the route service is unreachable. Meetup
 *    points are shared via broadcast; each device plans its own route to it.
 *
 * Interoperable with the Party Radar web app: same channel names, same event
 * names, same payload shapes — web and mobile players see each other live.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { randomUUID } from 'expo-crypto';
import { BroadcastEvent, getSupabase, partyChannelName } from '@/lib/supabase';
import { usePartyLocation } from '@/hooks/usePartyLocation';
import { MEMBER_COLORS, PING_TTL_MS } from '@/types/party';
import type {
  Coordinates,
  MemberUpdatePayload,
  MeetupClearPayload,
  MeetupPoint,
  MeetupSharePayload,
  PartyMember,
  PingPayload,
  PingRemovePayload,
  RouteInfo,
  RouteProfile,
  WaypointPing,
} from '@/types/party';
import { angleDiff, haversineMeters } from '@/lib/geo';
import { fetchRoute, RouteError, routeErrorNotice } from '@/lib/routing';

export type ConnectionState = 'connecting' | 'connected' | 'error';

export interface PartySyncState {
  localId: string;
  localPlayer: PartyMember | null;
  members: PartyMember[];
  pings: WaypointPing[];
  connectionState: ConnectionState;
  geoError: string | null;
  isTracking: boolean;
  /** Drops a waypoint ping. Returns false when throttled by the cooldown. */
  sendPing: (coords: Coordinates) => boolean;
  /** Removes one of YOUR pings for everyone in the room. */
  removePing: (pingId: string) => void;
  /** Route currently displayed (null when none). */
  activeRoute: RouteInfo | null;
  /** True while a route is being fetched. */
  routeLoading: boolean;
  /** Human notice when routing degraded to the crow-flies fallback. */
  routeNotice: string | null;
  /** Straight-line fallback destination when routing failed. */
  routeFallback: { dest: Coordinates; label: string } | null;
  /** Shared meetup point proposed to the party (null when none). */
  meetup: MeetupPoint | null;
  /** Active travel profile for routing. */
  routeProfile: RouteProfile;
  /** Plan a route to dest. False when throttled or GPS-less. */
  planRoute: (dest: Coordinates, label: string, profile: RouteProfile, force?: boolean) => Promise<boolean>;
  /** Re-run the last route request (bypasses the throttle). */
  retryRoute: () => void;
  /** Clear the current route display. */
  clearRoute: () => void;
  /** Change travel profile, re-planning the current route if any. */
  setRouteProfile: (profile: RouteProfile) => void;
  /** Propose a midpoint meetup to the party. False when nobody to meet. */
  proposeMeetup: () => boolean;
  /** Dismiss the meetup point (broadcasts the clear if you're the proposer). */
  dismissMeetup: () => void;
  /** Callsign after join-time dedupe (may differ from what was typed). */
  displayName: string;
  /** Marker color after join-time dedupe. */
  displayColor: string;
  /** One-shot high-accuracy GPS refresh. */
  refreshPosition: () => void;
}

const BROADCAST_TICK_MS = 2000;
const MOVE_THRESHOLD_M = 4;
const TURN_THRESHOLD_DEG = 12;
const HEARTBEAT_MS = 8000;
const MAX_PINGS = 12;
/** Don't drop a member missing from presence until their last broadcast is this old. */
const PRESENCE_GRACE_MS = 20_000;
/** Stashed member-updates from ids not yet in presence expire after this long. */
const PENDING_MEMBER_TTL_MS = 30_000;
/** Minimum gap between waypoint pings from the same device. */
const PING_COOLDOWN_MS = 2000;
/** Minimum gap between route-service requests from this device. */
const ROUTE_GAP_MS = 2500;

function payloadToMember(p: MemberUpdatePayload): PartyMember {
  return {
    id: p.id,
    name: p.name || '???',
    color: p.color || '#94a3b8',
    position: { lat: p.lat, lng: p.lng },
    heading: p.heading ?? null,
    speed: p.speed ?? null,
    accuracy: null,
    battery: p.battery ?? null,
    lastUpdated: p.ts || Date.now(),
  };
}

export function usePartySync(
  roomId: string,
  playerName: string,
  playerColor: string,
): PartySyncState {
  const geo = usePartyLocation();
  const [members, setMembers] = useState<Record<string, PartyMember>>({});
  const [pings, setPings] = useState<WaypointPing[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [displayName, setDisplayName] = useState(playerName);
  const [displayColor, setDisplayColor] = useState(playerColor);
  const [activeRoute, setActiveRoute] = useState<RouteInfo | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeNotice, setRouteNotice] = useState<string | null>(null);
  const [routeFallback, setRouteFallback] = useState<{ dest: Coordinates; label: string } | null>(null);
  const [meetup, setMeetup] = useState<MeetupPoint | null>(null);
  const [routeProfile, setRouteProfileState] = useState<RouteProfile>('foot');

  const localId = useMemo(() => randomUUID(), []);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const lastSentRef = useRef<{ lat: number; lng: number; heading: number | null; ts: number } | null>(null);
  /** Callable "broadcast right now" — installed by the broadcast loop effect. */
  const broadcastNowRef = useRef<() => void>(() => undefined);
  /** Epoch ms of the last member-update broadcast seen per member id. */
  const lastSeenBroadcastRef = useRef<Record<string, number>>({});
  /** Member-updates from ids not (yet) in presence — flushed on presence sync. */
  const pendingMembersRef = useRef<Record<string, { payload: MemberUpdatePayload; receivedAt: number }>>({});
  const knownIdsRef = useRef<Set<string>>(new Set());
  const lastPingAtRef = useRef(0);
  /** True once join dedupe has fixed the identity (stops props overwriting it). */
  const dedupedRef = useRef(false);

  // Refs so the broadcast interval never goes stale without re-subscribing.
  const geoRef = useRef(geo);
  geoRef.current = geo;
  const identityRef = useRef({ playerName, playerColor, localId });
  if (!dedupedRef.current) {
    identityRef.current.playerName = playerName;
    identityRef.current.playerColor = playerColor;
  }
  const pingsRef = useRef(pings);
  pingsRef.current = pings;
  const routeProfileRef = useRef<RouteProfile>('foot');
  const membersRef = useRef(members);
  membersRef.current = members;
  const meetupRef = useRef(meetup);
  meetupRef.current = meetup;
  /** Current route target (for retry / profile re-plan / meetup cleanup). */
  const routeTargetRef = useRef<{ dest: Coordinates; label: string; meetupId?: string } | null>(null);
  const routeInFlightRef = useRef(false);
  const lastRouteFetchAtRef = useRef(0);
  /** Ref mirror of planRoute so broadcast listeners can call it. */
  const planRouteRef = useRef<
    (dest: Coordinates, label: string, profile: RouteProfile, force?: boolean) => Promise<boolean>
  >(() => Promise.resolve(false));

  const clearRouteState = useCallback(() => {
    routeTargetRef.current = null;
    setActiveRoute(null);
    setRouteFallback(null);
    setRouteNotice(null);
    setRouteLoading(false);
  }, []);

  // Subscribe to the room channel.
  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let disposed = false;

    const applyMemberUpdate = (p: MemberUpdatePayload) => {
      lastSeenBroadcastRef.current[p.id] = Date.now();
      knownIdsRef.current.add(p.id);
      setMembers((prev) => ({ ...prev, [p.id]: payloadToMember(p) }));
    };

    try {
      const supabase = getSupabase();
      channel = supabase.channel(partyChannelName(roomId), {
        config: { broadcast: { ack: false }, presence: { key: localId } },
      });
      channelRef.current = channel;

      channel
        .on('broadcast', { event: BroadcastEvent.MEMBER_UPDATE }, ({ payload }) => {
          if (!channel) return;
          const p = payload as MemberUpdatePayload;
          if (!p || p.id === localId || typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
          // Presence-validation guard: never render ghosts. If the sender isn't
          // in presence (yet) and we've never seen them, stash the update and
          // flush it once a presence sync confirms them.
          const present = channel.presenceState();
          if (
            !Object.prototype.hasOwnProperty.call(present, p.id) &&
            !knownIdsRef.current.has(p.id)
          ) {
            const pending = pendingMembersRef.current;
            const cutoff = Date.now() - PENDING_MEMBER_TTL_MS;
            for (const id of Object.keys(pending)) {
              if (pending[id].receivedAt < cutoff) delete pending[id];
            }
            pending[p.id] = { payload: p, receivedAt: Date.now() };
            return;
          }
          applyMemberUpdate(p);
        })
        .on('broadcast', { event: BroadcastEvent.PING }, ({ payload }) => {
          const p = (payload as PingPayload)?.ping;
          if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') return;
          if (p.expiresAt <= Date.now()) return;
          setPings((prev) =>
            [...prev.filter((x) => x.expiresAt > Date.now() && x.id !== p.id), p].slice(-MAX_PINGS),
          );
        })
        .on('broadcast', { event: BroadcastEvent.PING_REMOVE }, ({ payload }) => {
          const id = (payload as PingRemovePayload)?.id;
          if (typeof id !== 'string' || !id) return;
          setPings((prev) => (prev.some((p) => p.id === id) ? prev.filter((p) => p.id !== id) : prev));
        })
        .on('broadcast', { event: BroadcastEvent.MEETUP_SHARE }, ({ payload }) => {
          const m = (payload as MeetupSharePayload)?.meetup;
          if (!m || typeof m.lat !== 'number' || typeof m.lng !== 'number' || !m.id) return;
          setMeetup(m);
          // Everyone plans their own route to the shared point — one request
          // per device, instead of one proposer's polyline for all.
          const dest = { lat: m.lat, lng: m.lng };
          const label = m.label || 'MEETUP POINT';
          void planRouteRef.current(dest, label, routeProfileRef.current, true);
          routeTargetRef.current = { dest, label, meetupId: m.id };
        })
        .on('broadcast', { event: BroadcastEvent.MEETUP_CLEAR }, ({ payload }) => {
          const id = (payload as MeetupClearPayload)?.id;
          if (typeof id !== 'string' || !id) return;
          if (meetupRef.current?.id === id) {
            setMeetup(null);
            if (routeTargetRef.current?.meetupId === id) clearRouteState();
          }
        })
        .on('presence', { event: 'sync' }, () => {
          if (!channel) return;
          const present = new Set(Object.keys(channel.presenceState()));

          // Flush stashed member-updates for ids that presence now confirms.
          const pending = pendingMembersRef.current;
          for (const id of Object.keys(pending)) {
            if (present.has(id)) {
              applyMemberUpdate(pending[id].payload);
              delete pending[id];
            }
          }

          // Remove members who left — but never on a racing sync: anyone whose
          // broadcast arrived within the grace window stays until it lapses.
          const now = Date.now();
          setMembers((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const id of Object.keys(next)) {
              const lastSeen = lastSeenBroadcastRef.current[id] ?? 0;
              if (!present.has(id) && now - lastSeen > PRESENCE_GRACE_MS) {
                delete next[id];
                knownIdsRef.current.delete(id);
                delete lastSeenBroadcastRef.current[id];
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        });

      channel.subscribe(async (status) => {
        if (disposed) return;
        if (status === 'SUBSCRIBED') {
          // Join dedupe: make callsign + color unique vs members already here.
          const state = channel?.presenceState() ?? {};
          const takenNames = new Set<string>();
          const takenColors = new Set<string>();
          for (const key of Object.keys(state)) {
            const meta = (state[key] as Array<{ name?: string; color?: string }> | undefined)?.[0];
            if (meta?.name) takenNames.add(meta.name.trim().toLowerCase());
            if (meta?.color) takenColors.add(meta.color);
          }
          const baseName = playerName.trim() || '???';
          let finalName = baseName;
          if (takenNames.has(finalName.toLowerCase())) {
            let i = 2;
            while (takenNames.has(`${baseName} ${i}`.toLowerCase())) i++;
            finalName = `${baseName} ${i}`;
          }
          let finalColor = playerColor;
          if (takenColors.has(finalColor)) {
            finalColor = MEMBER_COLORS.find((c) => !takenColors.has(c)) ?? playerColor;
          }
          dedupedRef.current = true;
          identityRef.current.playerName = finalName;
          identityRef.current.playerColor = finalColor;
          setDisplayName(finalName);
          setDisplayColor(finalColor);
          setConnectionState('connected');
          await channel?.track({
            id: localId,
            name: finalName,
            color: finalColor,
            joinedAt: Date.now(),
          });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setConnectionState('error');
        }
      });
    } catch {
      setConnectionState('error');
    }

    return () => {
      disposed = true;
      if (channel) {
        const ch = channel;
        // Give the presence-leave payload a beat to flush before the socket dies.
        void ch.untrack().catch(() => undefined);
        setTimeout(() => getSupabase().removeChannel(ch), 300);
      }
      channelRef.current = null;
    };
    // Intentionally not depending on playerName/playerColor: identity is fixed at join.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, localId]);

  // Throttled broadcast loop: send on move / turn / heartbeat.
  useEffect(() => {
    const tick = () => {
      const ch = channelRef.current;
      const g = geoRef.current;
      const id = identityRef.current;
      if (!ch || !g.position) return;

      const last = lastSentRef.current;
      const moved =
        !last || haversineMeters({ lat: last.lat, lng: last.lng }, g.position) > MOVE_THRESHOLD_M;
      const turned =
        !last ||
        (last.heading != null &&
          g.heading != null &&
          Math.abs(angleDiff(last.heading, g.heading)) > TURN_THRESHOLD_DEG);
      const heartbeat = !last || Date.now() - last.ts > HEARTBEAT_MS;
      if (!(moved || turned || heartbeat)) return;

      const payload: MemberUpdatePayload = {
        id: id.localId,
        name: id.playerName,
        color: id.playerColor,
        lat: g.position.lat,
        lng: g.position.lng,
        heading: g.heading,
        speed: g.speed,
        battery: g.battery,
        ts: Date.now(),
      };
      ch.send({ type: 'broadcast', event: BroadcastEvent.MEMBER_UPDATE, payload });
      lastSentRef.current = { lat: g.position.lat, lng: g.position.lng, heading: g.heading, ts: Date.now() };
    };

    broadcastNowRef.current = tick;
    tick();
    const t = setInterval(tick, BROADCAST_TICK_MS);
    return () => clearInterval(t);
  }, []);

  // When the app returns to the foreground, location + timers were throttled:
  // grab a fresh fix, force an immediate broadcast, re-track presence.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      geoRef.current.refreshPosition();
      lastSentRef.current = null; // force the next broadcast through
      broadcastNowRef.current();
      const ch = channelRef.current;
      const id = identityRef.current;
      if (ch) {
        void ch
          .track({ id: id.localId, name: id.playerName, color: id.playerColor, joinedAt: Date.now() })
          .catch(() => undefined);
      }
    });
    return () => sub.remove();
  }, []);

  // Prune expired pings.
  useEffect(() => {
    const t = setInterval(() => {
      setPings((prev) => {
        const next = prev.filter((p) => p.expiresAt > Date.now());
        return next.length === prev.length ? prev : next;
      });
    }, 5000);
    return () => clearInterval(t);
  }, []);

  const sendPing = useCallback((coords: Coordinates): boolean => {
    const now = Date.now();
    if (now - lastPingAtRef.current < PING_COOLDOWN_MS) return false;
    lastPingAtRef.current = now;
    const id = identityRef.current;
    const ping: WaypointPing = {
      id: randomUUID(),
      lat: coords.lat,
      lng: coords.lng,
      createdById: id.localId,
      createdByName: id.playerName,
      color: id.playerColor,
      createdAt: now,
      expiresAt: now + PING_TTL_MS,
    };
    setPings((prev) => [...prev.filter((p) => p.expiresAt > now), ping].slice(-MAX_PINGS));
    channelRef.current?.send({
      type: 'broadcast',
      event: BroadcastEvent.PING,
      payload: { ping } satisfies PingPayload,
    });
    return true;
  }, []);

  const removePing = useCallback(
    (pingId: string) => {
      // Only your own pins can be removed by you; everyone honors removals.
      const mine = pingsRef.current.some((p) => p.id === pingId && p.createdById === localId);
      if (!mine) return;
      setPings((prev) => prev.filter((p) => p.id !== pingId));
      channelRef.current?.send({
        type: 'broadcast',
        event: BroadcastEvent.PING_REMOVE,
        payload: { id: pingId } satisfies PingRemovePayload,
      });
    },
    [localId],
  );

  const planRoute = useCallback(
    async (dest: Coordinates, label: string, profile: RouteProfile, force = false): Promise<boolean> => {
      if (routeInFlightRef.current) return false;
      const now = Date.now();
      if (!force && now - lastRouteFetchAtRef.current < ROUTE_GAP_MS) return false;
      const origin = geoRef.current.position;
      if (!origin) return false;
      routeInFlightRef.current = true;
      lastRouteFetchAtRef.current = now;
      routeTargetRef.current = { dest, label };
      setRouteLoading(true);
      setRouteNotice(null);
      try {
        const r = await fetchRoute(origin, dest, profile);
        setActiveRoute({
          id: randomUUID(),
          profile,
          label,
          dest,
          distanceM: r.distanceM,
          durationS: r.durationS,
          polyline: r.polyline,
          createdAt: Date.now(),
          createdById: localId,
        });
        setRouteFallback(null);
        setRouteNotice(null);
        return true;
      } catch (e) {
        // Degrade to crow-flies: straight line + live distance, never a dead end.
        setActiveRoute(null);
        setRouteFallback({ dest, label });
        const kind = e instanceof RouteError ? e.kind : 'server';
        setRouteNotice(routeErrorNotice(kind, profile));
        return true;
      } finally {
        setRouteLoading(false);
        routeInFlightRef.current = false;
      }
    },
    [localId],
  );
  planRouteRef.current = planRoute;

  const retryRoute = useCallback(() => {
    const t = routeTargetRef.current;
    if (!t || routeInFlightRef.current) return;
    void planRoute(t.dest, t.label, routeProfileRef.current, true);
  }, [planRoute]);

  const clearRoute = useCallback(() => {
    clearRouteState();
  }, [clearRouteState]);

  const setRouteProfile = useCallback(
    (profile: RouteProfile) => {
      routeProfileRef.current = profile;
      setRouteProfileState(profile);
      const t = routeTargetRef.current;
      if (t && !routeInFlightRef.current) {
        void planRoute(t.dest, t.label, profile, true);
      }
    },
    [planRoute],
  );

  const proposeMeetup = useCallback((): boolean => {
    const g = geoRef.current;
    const pts: Coordinates[] = [];
    if (g.position) pts.push(g.position);
    for (const m of Object.values(membersRef.current)) pts.push(m.position);
    if (pts.length < 2) return false; // nobody to meet
    const mid = {
      lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length,
      lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length,
    };
    const id = identityRef.current;
    const point: MeetupPoint = {
      id: randomUUID(),
      lat: mid.lat,
      lng: mid.lng,
      label: 'MEETUP POINT',
      createdById: id.localId,
      createdByName: id.playerName,
      createdAt: Date.now(),
    };
    setMeetup(point);
    channelRef.current?.send({
      type: 'broadcast',
      event: BroadcastEvent.MEETUP_SHARE,
      payload: { meetup: point } satisfies MeetupSharePayload,
    });
    void planRoute(mid, point.label, routeProfileRef.current, true);
    // planRoute resets the target — re-tag it as the meetup afterwards.
    routeTargetRef.current = { dest: mid, label: point.label, meetupId: point.id };
    return true;
  }, [planRoute]);

  const dismissMeetup = useCallback(() => {
    const m = meetupRef.current;
    if (m) {
      if (m.createdById === localId) {
        channelRef.current?.send({
          type: 'broadcast',
          event: BroadcastEvent.MEETUP_CLEAR,
          payload: { id: m.id } satisfies MeetupClearPayload,
        });
      }
      setMeetup(null);
    }
    if (routeTargetRef.current?.meetupId) clearRouteState();
  }, [localId, clearRouteState]);

  const localPlayer = useMemo<PartyMember | null>(() => {
    if (!geo.position) return null;
    return {
      id: localId,
      name: displayName,
      color: displayColor,
      position: geo.position,
      heading: geo.heading,
      speed: geo.speed,
      accuracy: geo.accuracy,
      battery: geo.battery,
      lastUpdated: Date.now(),
    };
  }, [geo.position, geo.heading, geo.speed, geo.accuracy, geo.battery, localId, displayName, displayColor]);

  const memberList = useMemo(() => Object.values(members), [members]);

  return {
    localId,
    localPlayer,
    members: memberList,
    pings,
    connectionState,
    geoError: geo.error,
    isTracking: geo.isTracking,
    refreshPosition: geo.refreshPosition,
    sendPing,
    removePing,
    displayName,
    displayColor,
    activeRoute,
    routeLoading,
    routeNotice,
    routeFallback,
    meetup,
    routeProfile,
    planRoute,
    retryRoute,
    clearRoute,
    setRouteProfile,
    proposeMeetup,
    dismissMeetup,
  };
}
