/**
 * PartyRadar — the tactical circular minimap HUD, ported from the web app.
 *
 *  - Local player locked dead-center, always heading-up (the world rotates
 *    under you; falls back to north-up when the device has no compass).
 *  - Party members projected from lat/lng via bearing + haversine distance,
 *    rendered as colored arrows rotated to their own heading.
 *  - Out-of-range members clamp to the dial edge with a dashed ring.
 *  - Tap anywhere on the dial to drop a waypoint ping (converted back to
 *    lat/lng with the destination-point formula). Tap one of YOUR pings to
 *    remove it; tap someone else's ping or a member to route there.
 *  - Waypoint pings show a live countdown + distance readout.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, useWindowDimensions, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Polygon,
  RadialGradient,
  Rect,
  Stop,
  Text,
} from 'react-native-svg';
import { STALE_AFTER_MS } from '@/types/party';
import type { Coordinates, MeetupPoint, PartyMember, RouteInfo, WaypointPing } from '@/types/party';
import {
  bearingDegrees,
  destinationPoint,
  formatDistance,
  haversineMeters,
  normalize360,
  toRadians,
} from '@/lib/geo';

const SIZE = 440;
const C = SIZE / 2;
const PLOT_R = 188;
const RING_FRACTIONS = [1 / 3, 2 / 3, 1];

const AnimatedG = Animated.createAnimatedComponent(G);

interface PartyRadarProps {
  localId: string;
  localPlayer: PartyMember | null;
  members: PartyMember[];
  pings: WaypointPing[];
  radarRangeM: number;
  activeRoute: RouteInfo | null;
  routeFallback: { dest: Coordinates; label: string } | null;
  meetup: MeetupPoint | null;
  onPing: (coords: Coordinates) => void;
  /** Tap one of YOUR active pings to remove it for everyone. */
  onRemovePing: (pingId: string) => void;
  /** Start routing to a destination. */
  onRouteTo: (dest: Coordinates, label: string) => void;
}

export default function PartyRadar({
  localId,
  localPlayer,
  members,
  pings,
  radarRangeM,
  activeRoute,
  routeFallback,
  meetup,
  onPing,
  onRemovePing,
  onRouteTo,
}: PartyRadarProps) {
  const { width } = useWindowDimensions();
  const dialSize = Math.min(width * 0.94, 520);

  // Ticks every second for ping countdowns + stale detection.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Rotating sweep arm.
  const sweep = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: 4000,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [sweep]);
  const sweepRotation = sweep.interpolate({ inputRange: [0, 1], outputRange: [0, 360] });

  const heading = localPlayer?.heading ?? 0;
  const origin = localPlayer?.position ?? null;
  const hasCompass = localPlayer?.heading != null;

  /**
   * Project a target onto the dial: bearing relative to the player's heading
   * becomes a clockwise angle from "up", distance becomes a radius.
   */
  const toScreen = useCallback(
    (bearing: number, distM: number) => {
      const rel = normalize360(bearing - heading);
      const rad = toRadians(rel);
      const rr = (Math.min(distM, radarRangeM) / radarRangeM) * PLOT_R;
      return {
        x: C + rr * Math.sin(rad),
        y: C - rr * Math.cos(rad),
        rel,
        clamped: distM > radarRangeM,
      };
    },
    [heading, radarRangeM],
  );

  const activePings = useMemo(() => pings.filter((p) => p.expiresAt > now), [pings, now]);

  /** Touch → dial coords → meters east/north of player → absolute bearing → lat/lng. */
  const handleTouch = useCallback(
    (locationX: number, locationY: number) => {
      if (!origin) return;
      const px = (locationX / dialSize) * SIZE;
      const py = (locationY / dialSize) * SIZE;
      // Tapping one of YOUR active pings removes it for everyone instead of
      // dropping a new one; tapping someone else's ping or a member routes to it.
      for (const p of activePings) {
        const s = toScreen(
          bearingDegrees(origin, { lat: p.lat, lng: p.lng }),
          haversineMeters(origin, { lat: p.lat, lng: p.lng }),
        );
        if (Math.hypot(px - s.x, py - s.y) < 22) {
          if (p.createdById === localId) onRemovePing(p.id);
          else onRouteTo({ lat: p.lat, lng: p.lng }, `PING by ${p.createdByName}`);
          return;
        }
      }
      for (const m of members) {
        const s = toScreen(
          bearingDegrees(origin, m.position),
          haversineMeters(origin, m.position),
        );
        if (Math.hypot(px - s.x, py - s.y) < 24) {
          onRouteTo(m.position, m.name);
          return;
        }
      }
      const dx = px - C;
      const dy = py - C;
      const eastM = (dx / PLOT_R) * radarRangeM;
      const northM = (-dy / PLOT_R) * radarRangeM; // screen y grows downward
      const distM = Math.hypot(eastM, northM);
      if (distM < 3) return; // tapped dead-center: ignore
      const relBearing = normalize360((Math.atan2(eastM, northM) * 180) / Math.PI);
      onPing(destinationPoint(origin, normalize360(relBearing + heading), distM));
    },
    [origin, activePings, members, toScreen, localId, onPing, onRemovePing, onRouteTo, dialSize, heading, radarRangeM],
  );

  const ticks = useMemo(
    () =>
      Array.from({ length: 24 }, (_, i) => {
        const a = toRadians(i * 15);
        const major = i % 6 === 0;
        const r1 = PLOT_R - (major ? 15 : 8);
        const r2 = PLOT_R - 2;
        return {
          key: i,
          x1: C + r1 * Math.sin(a),
          y1: C - r1 * Math.cos(a),
          x2: C + r2 * Math.sin(a),
          y2: C - r2 * Math.cos(a),
          major,
        };
      }),
    [],
  );

  // Cardinal labels counter-rotate so "N" always points at true north.
  const cardinals = useMemo(
    () =>
      [
        { label: 'N', bearing: 0, color: '#f87171' },
        { label: 'E', bearing: 90, color: '#94a3b8' },
        { label: 'S', bearing: 180, color: '#94a3b8' },
        { label: 'W', bearing: 270, color: '#94a3b8' },
      ].map((c) => {
        const rel = toRadians(normalize360(c.bearing - heading));
        const r = PLOT_R - 28;
        return { ...c, x: C + r * Math.sin(rel), y: C - r * Math.cos(rel) };
      }),
    [heading],
  );

  const accuracyR =
    localPlayer?.accuracy != null
      ? (Math.min(localPlayer.accuracy, radarRangeM) / radarRangeM) * PLOT_R
      : 0;

  // Route geometry projected onto the dial (points beyond range clamp to edge).
  const routePath = useMemo(() => {
    if (!origin || !activeRoute || activeRoute.polyline.length < 2) return null;
    return activeRoute.polyline
      .map(([la, ln], i) => {
        const s = toScreen(
          bearingDegrees(origin, { lat: la, lng: ln }),
          haversineMeters(origin, { lat: la, lng: ln }),
        );
        return `${i === 0 ? 'M' : 'L'}${s.x.toFixed(1)},${s.y.toFixed(1)}`;
      })
      .join(' ');
  }, [origin, activeRoute, toScreen]);

  const routeDestScreen = useMemo(() => {
    if (!origin || !activeRoute) return null;
    return toScreen(
      bearingDegrees(origin, activeRoute.dest),
      haversineMeters(origin, activeRoute.dest),
    );
  }, [origin, activeRoute, toScreen]);

  const fallbackScreen = useMemo(() => {
    if (!origin || !routeFallback) return null;
    return toScreen(
      bearingDegrees(origin, routeFallback.dest),
      haversineMeters(origin, routeFallback.dest),
    );
  }, [origin, routeFallback, toScreen]);

  const meetupScreen = useMemo(() => {
    if (!origin || !meetup) return null;
    return toScreen(
      bearingDegrees(origin, { lat: meetup.lat, lng: meetup.lng }),
      haversineMeters(origin, { lat: meetup.lat, lng: meetup.lng }),
    );
  }, [origin, meetup, toScreen]);

  const MONO = 'monospace';

  return (
    <View
      style={{ width: dialSize, height: dialSize }}
      onTouchEnd={(e) => handleTouch(e.nativeEvent.locationX, e.nativeEvent.locationY)}
    >
      <Svg width={dialSize} height={dialSize} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <Defs>
          <RadialGradient id="radar-bg" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor="#0b1526" stopOpacity={0.95} />
            <Stop offset="70%" stopColor="#070d18" stopOpacity={0.9} />
            <Stop offset="100%" stopColor="#04070d" stopOpacity={0.85} />
          </RadialGradient>
          <LinearGradient id="sweep-grad" x1="0" y1="1" x2="0" y2="0">
            <Stop offset="0%" stopColor="#22d3ee" stopOpacity={0} />
            <Stop offset="100%" stopColor="#22d3ee" stopOpacity={0.9} />
          </LinearGradient>
          <LinearGradient id="bezel-grad" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0%" stopColor="#38bdf8" />
            <Stop offset="50%" stopColor="#1e3a5f" />
            <Stop offset="100%" stopColor="#a78bfa" />
          </LinearGradient>
        </Defs>

        {/* bezel */}
        <Circle cx={C} cy={C} r={214} fill="none" stroke="url(#bezel-grad)" strokeWidth={3} opacity={0.8} />
        <Circle cx={C} cy={C} r={206} fill="none" stroke="#1e293b" strokeWidth={1.5} />

        {/* plot background */}
        <Circle cx={C} cy={C} r={PLOT_R} fill="url(#radar-bg)" stroke="#164e63" strokeWidth={1.5} />

        {/* range rings */}
        {RING_FRACTIONS.map((f) => (
          <G key={f}>
            <Circle
              cx={C}
              cy={C}
              r={PLOT_R * f}
              fill="none"
              stroke="#22d3ee"
              strokeWidth={1}
              opacity={f === 1 ? 0.5 : 0.22}
              strokeDasharray={f === 1 ? undefined : '4 6'}
            />
            {f < 1 && (
              <Text x={C + 4} y={C - PLOT_R * f + 12} fontSize={9} fill="#475569" fontFamily={MONO}>
                {formatDistance(radarRangeM * f)}
              </Text>
            )}
          </G>
        ))}

        {/* crosshair */}
        <Line x1={C - PLOT_R} y1={C} x2={C + PLOT_R} y2={C} stroke="#164e63" strokeWidth={1} opacity={0.6} />
        <Line x1={C} y1={C - PLOT_R} x2={C} y2={C + PLOT_R} stroke="#164e63" strokeWidth={1} opacity={0.6} />

        {/* dial ticks */}
        {ticks.map((t) => (
          <Line
            key={t.key}
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
            stroke={t.major ? '#67e8f9' : '#1e3a5f'}
            strokeWidth={t.major ? 2 : 1}
            opacity={t.major ? 0.9 : 0.8}
          />
        ))}

        {/* cardinals */}
        {cardinals.map((c) => (
          <Text
            key={c.label}
            x={c.x}
            y={c.y + 4}
            textAnchor="middle"
            fontSize={13}
            fontWeight="700"
            fill={c.color}
            fontFamily={MONO}
          >
            {c.label}
          </Text>
        ))}

        {/* rotating sweep */}
        <AnimatedG rotation={sweepRotation} origin={`${C}, ${C}`} opacity={0.55}>
          <Line x1={C} y1={C} x2={C} y2={C - PLOT_R} stroke="url(#sweep-grad)" strokeWidth={3} strokeLinecap="round" />
        </AnimatedG>

        {/* range readout */}
        <Text x={C} y={C + PLOT_R + 16} textAnchor="middle" fontSize={10} fill="#64748b" fontFamily={MONO}>
          {`RANGE ${formatDistance(radarRangeM).toUpperCase()}${hasCompass ? '' : ' · N-UP'}`}
        </Text>

        {/* GPS accuracy halo */}
        {accuracyR > 2 && <Circle cx={C} cy={C} r={accuracyR} fill="#fbbf24" opacity={0.05} />}

        {/* waypoint pings */}
        {origin &&
          activePings.map((p) => {
            const target = { lat: p.lat, lng: p.lng };
            const dist = haversineMeters(origin, target);
            const b = bearingDegrees(origin, target);
            const { x, y } = toScreen(b, dist);
            const secs = Math.max(0, Math.ceil((p.expiresAt - now) / 1000));
            return (
              <G key={p.id}>
                <Circle cx={x} cy={y} r={7} fill={p.color} />
                <Circle cx={x} cy={y} r={11} fill="none" stroke={p.color} strokeWidth={2} opacity={0.6} />
                <Text
                  x={x}
                  y={y - 18}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight="700"
                  fill={p.color}
                  fontFamily={MONO}
                >
                  {`PING ${secs}s`}
                </Text>
                <Text
                  x={x}
                  y={y + 26}
                  textAnchor="middle"
                  fontSize={10}
                  fill="#e2e8f0"
                  fontFamily={MONO}
                >
                  {formatDistance(dist)}
                </Text>
              </G>
            );
          })}

        {/* active route */}
        {routePath && (
          <Path
            d={routePath}
            fill="none"
            stroke="#22d3ee"
            strokeWidth={3}
            opacity={0.85}
            strokeLinecap="round"
          />
        )}
        {routeDestScreen && (
          <G>
            <Circle cx={routeDestScreen.x} cy={routeDestScreen.y} r={8} fill="#22d3ee" stroke="#04070d" strokeWidth={2} />
            <Circle cx={routeDestScreen.x} cy={routeDestScreen.y} r={3} fill="#04070d" />
          </G>
        )}

        {/* crow-flies fallback: straight dashed line */}
        {fallbackScreen && (
          <G>
            <Line
              x1={C}
              y1={C}
              x2={fallbackScreen.x}
              y2={fallbackScreen.y}
              stroke="#f59e0b"
              strokeWidth={2.5}
              strokeDasharray="10 8"
              opacity={0.9}
            />
            <Circle cx={fallbackScreen.x} cy={fallbackScreen.y} r={8} fill="#f59e0b" stroke="#04070d" strokeWidth={2} />
          </G>
        )}

        {/* shared meetup point */}
        {meetupScreen && (
          <G>
            <Rect
              x={meetupScreen.x - 9}
              y={meetupScreen.y - 9}
              width={18}
              height={18}
              fill="#fbbf24"
              stroke="#04070d"
              strokeWidth={2}
              rotation={45}
              origin={`${meetupScreen.x}, ${meetupScreen.y}`}
            />
            <Text
              x={meetupScreen.x}
              y={meetupScreen.y - 18}
              textAnchor="middle"
              fontSize={10}
              fontWeight="700"
              fill="#fbbf24"
              fontFamily={MONO}
            >
              MEETUP
            </Text>
          </G>
        )}

        {/* party members */}
        {origin &&
          members.map((m) => {
            const dist = haversineMeters(origin, m.position);
            const b = bearingDegrees(origin, m.position);
            const { x, y, rel, clamped } = toScreen(b, dist);
            const stale = now - m.lastUpdated > STALE_AFTER_MS;
            const moving = (m.speed ?? 0) > 0.8 && !stale;
            // Arrow points where THEY face, relative to YOUR view.
            const rot = m.heading != null ? normalize360(m.heading - heading) : rel;
            return (
              <G key={m.id} opacity={stale ? 0.35 : 1}>
                {clamped ? (
                  <Circle cx={x} cy={y} r={12} fill="none" stroke={m.color} strokeWidth={1.5} strokeDasharray="3 3" />
                ) : (
                  <Circle cx={x} cy={y} r={14} fill={m.color} opacity={0.12} />
                )}
                <G rotation={rot} origin={`${x.toFixed(1)}, ${y.toFixed(1)}`} x={x} y={y}>
                  {m.heading != null ? (
                    <Polygon points="0,-13 8,9 0,4 -8,9" fill={m.color} stroke="#04070d" strokeWidth={1.5} />
                  ) : (
                    <Rect x={-7} y={-7} width={14} height={14} fill={m.color} stroke="#04070d" strokeWidth={1.5} rotation={45} origin="0, 0" />
                  )}
                </G>
                <Text
                  x={x}
                  y={y - 20}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight="700"
                  fill="#f1f5f9"
                  fontFamily={MONO}
                >
                  {m.name}
                </Text>
                <Text
                  x={x}
                  y={y + 28}
                  textAnchor="middle"
                  fontSize={10}
                  fill={m.color}
                  fontFamily={MONO}
                >
                  {`${formatDistance(dist)}${stale ? ' · STALE' : moving ? ' · MOVING' : ''}`}
                </Text>
              </G>
            );
          })}

        {/* local player: dead center, heading-up */}
        {origin ? (
          <G>
            <Polygon
              points={`${C},${C - 17} ${C + 10},${C + 11} ${C},${C + 5} ${C - 10},${C + 11}`}
              fill="#fbbf24"
              stroke="#04070d"
              strokeWidth={2}
            />
            <Circle cx={C} cy={C} r={3.5} fill="#04070d" stroke="#fbbf24" strokeWidth={1.5} />
            <Text
              x={C}
              y={C + 34}
              textAnchor="middle"
              fontSize={11}
              fontWeight="700"
              fill="#fbbf24"
              fontFamily={MONO}
            >
              YOU
            </Text>
          </G>
        ) : (
          <Text x={C} y={C} textAnchor="middle" fontSize={13} fill="#67e8f9" fontFamily={MONO}>
            ACQUIRING SIGNAL…
          </Text>
        )}
      </Svg>
    </View>
  );
}
