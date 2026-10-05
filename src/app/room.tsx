/**
 * /room — the live party session on a real map.
 * MapLibre (OpenStreetMap tiles, no API keys) + Supabase Realtime sync.
 *
 * Interactions mirror the web app:
 *  - Long-press the map to drop a waypoint ping (2 s cooldown).
 *  - Tap a member or someone else's ping to route there.
 *  - Tap YOUR ping to remove it for everyone.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  Marker,
  type CameraRef,
} from '@maplibre/maplibre-react-native';
import { usePartySync } from '@/hooks/usePartySync';
import MemberList from '@/components/MemberList';
import { OSM_RASTER_STYLE } from '@/lib/mapStyle';
import { formatDistance, formatDuration } from '@/lib/geo';
import type { Coordinates, RouteProfile } from '@/types/party';

export default function RoomScreen() {
  const params = useLocalSearchParams<{ roomId?: string; name?: string; color?: string }>();
  const roomId = (params.roomId ?? '').toUpperCase().slice(0, 12);
  const name = params.name ?? '???';
  const color = params.color ?? '#22d3ee';

  const sync = usePartySync(roomId, name, color);
  const [followMode, setFollowMode] = useState(true);
  const [flash, setFlash] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const cameraRef = useRef<CameraRef>(null);
  const hasCenteredRef = useRef(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFlash = useCallback((msg: string, ms = 1600) => {
    setFlash(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), ms);
  }, []);

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  // Follow the local player until the user pans the map themselves.
  const localPos = sync.localPlayer?.position;
  useEffect(() => {
    if (!localPos || !followMode) return;
    const target = { center: [localPos.lng, localPos.lat] as [number, number] };
    if (!hasCenteredRef.current) {
      hasCenteredRef.current = true;
      cameraRef.current?.easeTo({ ...target, zoom: 15, duration: 800 });
    } else {
      cameraRef.current?.easeTo({ ...target, duration: 400 });
    }
  }, [localPos, followMode]);

  const handleLongPressMap = useCallback(
    (lng: number, lat: number) => {
      const sent = sync.sendPing({ lat, lng });
      showFlash(sent ? 'WAYPOINT PING BROADCAST' : 'PING COOLDOWN — WAIT A BEAT');
    },
    [sync, showFlash],
  );

  const handleRouteTo = useCallback(
    (dest: Coordinates, label: string) => {
      void sync.planRoute(dest, label, sync.routeProfile).then((ok) => {
        if (!ok) showFlash('ROUTING BUSY — TRY AGAIN');
      });
    },
    [sync, showFlash],
  );

  const handleRemovePing = useCallback(
    (pingId: string) => {
      sync.removePing(pingId);
      showFlash('WAYPOINT PING REMOVED');
    },
    [sync, showFlash],
  );

  const handleMeetup = useCallback(() => {
    const ok = sync.proposeMeetup();
    showFlash(ok ? 'MEETUP POINT SHARED' : 'NO SQUAD MEMBERS TO MEET YET', 1800);
  }, [sync, showFlash]);

  const copyCode = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(roomId);
    } catch {
      /* clipboard unavailable */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [roomId]);

  const routeLine = useMemo(() => {
    if (!sync.activeRoute) return null;
    return {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: sync.activeRoute.polyline.map(([lat, lng]) => [lng, lat]),
      },
    };
  }, [sync.activeRoute]);

  const fallbackLine = useMemo(() => {
    if (!sync.routeFallback || !localPos) return null;
    const d = sync.routeFallback.dest;
    return {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [localPos.lng, localPos.lat],
          [d.lng, d.lat],
        ],
      },
    };
  }, [sync.routeFallback, localPos]);

  const connColor =
    sync.connectionState === 'connected'
      ? '#34d399'
      : sync.connectionState === 'error'
        ? '#f87171'
        : '#fbbf24';

  return (
    <View style={styles.root}>
      <Map
        style={styles.map}
        mapStyle={OSM_RASTER_STYLE}
        attribution
        logo={false}
        onLongPress={(e) => {
          const [lng, lat] = e.nativeEvent.lngLat;
          handleLongPressMap(lng, lat);
        }}
        onRegionDidChange={(e) => {
          if (e.nativeEvent.userInteraction) setFollowMode(false);
        }}
      >
        <Camera ref={cameraRef} />

        {/* route polylines */}
        {routeLine && (
          <GeoJSONSource id="route-source" data={routeLine}>
            <Layer
              id="route-line"
              type="line"
              style={{ lineColor: '#22d3ee', lineWidth: 4, lineOpacity: 0.9 }}
            />
          </GeoJSONSource>
        )}
        {fallbackLine && (
          <GeoJSONSource id="fallback-source" data={fallbackLine}>
            <Layer
              id="fallback-line"
              type="line"
              style={{
                lineColor: '#f59e0b',
                lineWidth: 3,
                lineDasharray: [2, 2],
                lineOpacity: 0.9,
              }}
            />
          </GeoJSONSource>
        )}

        {/* local player */}
        {sync.localPlayer && (
          <Marker id="__me" lngLat={[localPos!.lng, localPos!.lat]}>
            <View style={styles.meWrap}>
              {sync.localPlayer.heading != null && (
                <View
                  style={[
                    styles.wedge,
                    { transform: [{ rotate: `${sync.localPlayer.heading}deg` }] },
                  ]}
                />
              )}
              <View
                style={[
                  styles.meDot,
                  { backgroundColor: sync.displayColor, shadowColor: sync.displayColor },
                ]}
              />
            </View>
          </Marker>
        )}

        {/* squad members — tap to route */}
        {sync.members.map((m) => (
          <Marker
            key={m.id}
            id={m.id}
            lngLat={[m.position.lng, m.position.lat]}
            onPress={() => handleRouteTo(m.position, m.name)}
          >
            <View style={styles.memberWrap}>
              <View
                style={[
                  styles.memberDot,
                  { backgroundColor: m.color, shadowColor: m.color },
                ]}
              />
              <Text style={styles.markerLabel}>{m.name}</Text>
            </View>
          </Marker>
        ))}

        {/* pings — tap yours to remove, others' to route */}
        {sync.pings.map((p) => (
          <Marker
            key={p.id}
            id={p.id}
            lngLat={[p.lng, p.lat]}
            onPress={() =>
              p.createdById === sync.localId
                ? handleRemovePing(p.id)
                : handleRouteTo({ lat: p.lat, lng: p.lng }, `PING by ${p.createdByName}`)
            }
          >
            <View style={[styles.ping, { backgroundColor: p.color, shadowColor: p.color }]} />
          </Marker>
        ))}

        {/* shared meetup point */}
        {sync.meetup && (
          <Marker id="__meetup" lngLat={[sync.meetup.lng, sync.meetup.lat]}>
            <View style={styles.meetup}>
              <Text style={styles.meetupText}>★</Text>
            </View>
          </Marker>
        )}
      </Map>

      {/* HUD header */}
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.headerRow}>
          <Pressable onPress={copyCode} style={styles.roomCode}>
            <Text style={styles.roomCodeText}>
              {roomId} <Text style={styles.copyHint}>{copied ? 'COPIED' : 'COPY'}</Text>
            </Text>
          </Pressable>
          <View style={styles.headerMeta}>
            <View style={[styles.connDot, { backgroundColor: connColor }]} />
            <Text style={styles.metaText}>{sync.connectionState.toUpperCase()}</Text>
            <Text style={styles.metaText}>{sync.members.length + 1}/4 IN PARTY</Text>
            <Pressable onPress={() => router.back()} style={styles.leave}>
              <Text style={styles.leaveText}>LEAVE</Text>
            </Pressable>
          </View>
        </View>
        <View style={styles.youRow}>
          <View
            style={[styles.dot, { backgroundColor: sync.displayColor, shadowColor: sync.displayColor }]}
          />
          <Text style={styles.metaText}>YOU · {sync.displayName.toUpperCase()}</Text>
        </View>
      </SafeAreaView>

      {/* banners */}
      {sync.geoError && (
        <View style={[styles.banner, styles.bannerError]}>
          <Text style={styles.bannerText}>GPS: {sync.geoError}</Text>
        </View>
      )}
      {sync.routeNotice && (
        <View style={[styles.banner, styles.bannerWarn]}>
          <Text style={styles.bannerText}>{sync.routeNotice}</Text>
          <Pressable onPress={sync.retryRoute} style={styles.retryBtn}>
            <Text style={styles.retryText}>RETRY</Text>
          </Pressable>
        </View>
      )}
      {flash && (
        <View style={styles.flash}>
          <Text style={styles.flashText}>{flash}</Text>
        </View>
      )}

      {/* meetup chip */}
      {sync.meetup && !sync.activeRoute && !sync.routeFallback && !sync.routeLoading && (
        <View style={styles.meetupChip}>
          <Text style={styles.meetupChipText}>
            MEETUP · {sync.meetup.createdByName.toUpperCase()}
          </Text>
          <Pressable
            onPress={() =>
              void sync.planRoute(
                { lat: sync.meetup!.lat, lng: sync.meetup!.lng },
                sync.meetup!.label,
                sync.routeProfile,
                true,
              )
            }
            style={styles.chipBtn}
          >
            <Text style={styles.chipBtnText}>ROUTE</Text>
          </Pressable>
          <Pressable onPress={sync.dismissMeetup} style={styles.chipBtn}>
            <Text style={styles.chipBtnText}>✕</Text>
          </Pressable>
        </View>
      )}

      {/* route status bar */}
      {(sync.routeLoading || sync.activeRoute || sync.routeFallback) && (
        <View style={styles.routeBar}>
          {sync.routeLoading ? (
            <Text style={styles.routeLoading}>ROUTING…</Text>
          ) : sync.activeRoute ? (
            <>
              <View style={[styles.dot, { backgroundColor: '#22d3ee', shadowColor: '#22d3ee' }]} />
              <Text style={styles.routeLabel} numberOfLines={1}>
                {sync.activeRoute.label.toUpperCase()}
              </Text>
              <Text style={styles.routeMeta}>
                {formatDistance(sync.activeRoute.distanceM)} ·{' '}
                {formatDuration(sync.activeRoute.durationS)}
              </Text>
              <ProfileToggle profile={sync.routeProfile} onChange={sync.setRouteProfile} />
              <Pressable onPress={sync.clearRoute}>
                <Text style={styles.xBtn}>✕</Text>
              </Pressable>
            </>
          ) : sync.routeFallback ? (
            <>
              <View style={[styles.dot, { backgroundColor: '#f59e0b', shadowColor: '#f59e0b' }]} />
              <Text style={styles.routeLabel} numberOfLines={1}>
                {sync.routeFallback.label.toUpperCase()}
              </Text>
              <Text style={[styles.routeMeta, { color: '#fcd34d' }]}>STRAIGHT LINE</Text>
              <Pressable onPress={sync.retryRoute} style={styles.retryBtn}>
                <Text style={styles.retryText}>RETRY</Text>
              </Pressable>
              <Pressable onPress={sync.clearRoute}>
                <Text style={styles.xBtn}>✕</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      )}

      {/* bottom controls + roster */}
      <SafeAreaView style={styles.footer} edges={['bottom']}>
        <View style={styles.controls}>
          <Pressable
            onPress={() => {
              if (sync.localPlayer) {
                const sent = sync.sendPing(sync.localPlayer.position);
                showFlash(sent ? 'WAYPOINT PING BROADCAST' : 'PING COOLDOWN — WAIT A BEAT');
              }
            }}
            style={styles.controlBtn}
          >
            <Text style={[styles.controlText, { color: '#f0abfc' }]}>PING MY LOCATION</Text>
          </Pressable>
          <Pressable
            onPress={handleMeetup}
            disabled={sync.members.length === 0}
            style={[styles.controlBtn, sync.members.length === 0 && styles.disabled]}
          >
            <Text style={[styles.controlText, { color: '#fcd34d' }]}>MEET UP</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setFollowMode(true);
              const p = sync.localPlayer?.position;
              if (p) cameraRef.current?.easeTo({ center: [p.lng, p.lat], zoom: 15, duration: 600 });
            }}
            style={[styles.controlBtn, followMode && styles.controlActive]}
          >
            <Text style={[styles.controlText, { color: '#67e8f9' }]}>
              {followMode ? '◎ FOLLOWING' : '◎ RECENTER'}
            </Text>
          </Pressable>
        </View>
        <MemberList members={sync.members} origin={sync.localPlayer} />
        <Text style={styles.hint}>
          LONG-PRESS MAP TO DROP A PIN · TAP A PIN OR MEMBER TO ROUTE · TAP YOUR PIN TO REMOVE IT
        </Text>
      </SafeAreaView>
    </View>
  );
}

function ProfileToggle({
  profile,
  onChange,
}: {
  profile: RouteProfile;
  onChange: (p: RouteProfile) => void;
}) {
  return (
    <View style={styles.toggle}>
      {(['foot', 'driving'] as const).map((p) => (
        <Pressable
          key={p}
          onPress={() => p !== profile && onChange(p)}
          style={[styles.toggleOpt, profile === p && styles.toggleOptActive]}
        >
          <Text style={[styles.toggleText, profile === p && styles.toggleTextActive]}>
            {p === 'foot' ? 'WALK' : 'DRIVE'}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#04060c' },
  map: { ...StyleSheet.absoluteFill },

  /* markers */
  meWrap: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  wedge: {
    position: 'absolute',
    top: 2,
    width: 0,
    height: 0,
    borderLeftWidth: 7,
    borderRightWidth: 7,
    borderBottomWidth: 13,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: 'rgba(255,255,255,0.9)',
  },
  meDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: '#fff',
    shadowOpacity: 0.9,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  memberWrap: { alignItems: 'center' },
  memberDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#fff',
    shadowOpacity: 0.9,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  markerLabel: {
    marginTop: 2,
    fontSize: 10,
    fontWeight: '700',
    color: '#fff',
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowRadius: 4,
  },
  ping: {
    width: 18,
    height: 18,
    borderRadius: 3,
    transform: [{ rotate: '45deg' }],
    borderWidth: 2,
    borderColor: '#fff',
    shadowOpacity: 0.9,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  meetup: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(120,53,15,0.9)',
    borderWidth: 2,
    borderColor: '#f59e0b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  meetupText: { color: '#fcd34d', fontSize: 18 },

  /* HUD */
  header: { position: 'absolute', top: 0, left: 0, right: 0 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(6,10,19,0.92)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(34,211,238,0.25)',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  roomCode: { padding: 4 },
  roomCodeText: { fontSize: 20, fontWeight: '800', letterSpacing: 3, color: '#fcd34d' },
  copyHint: { fontSize: 10, color: '#64748b', letterSpacing: 1 },
  headerMeta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  connDot: { width: 8, height: 8, borderRadius: 4 },
  metaText: { fontSize: 10, letterSpacing: 1.5, color: '#94a3b8', fontWeight: '600' },
  youRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: 'rgba(6,10,19,0.75)',
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
    elevation: 3,
  },
  leave: {
    borderWidth: 1,
    borderColor: 'rgba(127,29,29,0.8)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  leaveText: { fontSize: 10, letterSpacing: 1.5, color: '#fca5a5', fontWeight: '700' },

  banner: {
    position: 'absolute',
    top: 108,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
  },
  bannerError: { backgroundColor: 'rgba(69,10,10,0.9)', borderColor: 'rgba(127,29,29,0.6)' },
  bannerWarn: { backgroundColor: 'rgba(69,26,3,0.9)', borderColor: 'rgba(146,64,14,0.6)' },
  bannerText: { fontSize: 12, color: '#fecaca', textAlign: 'center', flexShrink: 1 },
  retryBtn: {
    borderWidth: 1,
    borderColor: '#b45309',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  retryText: { fontSize: 10, letterSpacing: 1.5, color: '#fcd34d', fontWeight: '700' },

  flash: {
    position: 'absolute',
    top: 160,
    alignSelf: 'center',
    borderWidth: 1,
    borderColor: 'rgba(162,28,175,0.7)',
    backgroundColor: 'rgba(59,7,100,0.9)',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  flashText: { fontSize: 10, letterSpacing: 2.5, color: '#f0abfc', fontWeight: '700' },

  meetupChip: {
    position: 'absolute',
    top: 160,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: '#b45309',
    backgroundColor: 'rgba(69,26,3,0.92)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  meetupChipText: { fontSize: 10, letterSpacing: 2, color: '#fde68a', fontWeight: '700' },
  chipBtn: {
    borderWidth: 1,
    borderColor: '#b45309',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  chipBtnText: { fontSize: 10, color: '#fde68a', fontWeight: '700' },

  routeBar: {
    position: 'absolute',
    bottom: 168,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(14,116,144,0.8)',
    backgroundColor: 'rgba(6,10,19,0.95)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    maxWidth: '94%',
  },
  routeLoading: { fontSize: 11, letterSpacing: 3, color: '#67e8f9', fontWeight: '700' },
  routeLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 1, color: '#f1f5f9', maxWidth: 120 },
  routeMeta: { fontSize: 11, color: '#a5f3fc' },
  xBtn: { fontSize: 12, color: '#64748b', paddingHorizontal: 4 },

  toggle: { flexDirection: 'row', borderWidth: 1, borderColor: '#334155', borderRadius: 6, overflow: 'hidden' },
  toggleOpt: { paddingHorizontal: 8, paddingVertical: 5 },
  toggleOptActive: { backgroundColor: '#0e7490' },
  toggleText: { fontSize: 10, letterSpacing: 1, color: '#64748b', fontWeight: '700' },
  toggleTextActive: { color: '#ecfeff' },

  footer: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  controls: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  controlBtn: {
    borderWidth: 1,
    borderColor: 'rgba(14,116,144,0.8)',
    backgroundColor: 'rgba(6,10,19,0.92)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  controlActive: { borderColor: '#22d3ee' },
  controlText: { fontSize: 10, letterSpacing: 2, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  hint: {
    textAlign: 'center',
    fontSize: 9,
    letterSpacing: 1.5,
    color: '#475569',
    paddingBottom: 4,
    paddingHorizontal: 12,
  },
});
