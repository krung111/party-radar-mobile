/**
 * Tracks the device's position (expo-location) and compass heading
 * (expo-sensors Magnetometer), with smoothing so markers don't jitter.
 *
 * Heading is derived from the magnetometer's x/y axes:
 *   heading = -(atan2(x, y))  →  0° when the top of the phone faces magnetic north.
 * It's magnetic north (not true north) and uncompensated for tilt — good enough
 * for a party-finder HUD, and it works on both platforms with no API keys.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { Magnetometer } from 'expo-sensors';
import * as Battery from 'expo-battery';
import type { Coordinates } from '@/types/party';
import { lerpAngle, normalize360, toDegrees } from '@/lib/geo';

export interface PartyLocationState {
  position: Coordinates | null;
  accuracy: number | null;
  /** Compass heading, degrees clockwise from north. Null until a compass reading arrives. */
  heading: number | null;
  /** Speed in m/s, or null when the device doesn't report it. */
  speed: number | null;
  /** Battery level 0..1, or null when unavailable. */
  battery: number | null;
  error: string | null;
  isTracking: boolean;
  /** One-shot high-accuracy GPS read that updates position immediately. */
  refreshPosition: () => void;
}

function magnetometerToHeading(x: number, y: number): number {
  return normalize360(-toDegrees(Math.atan2(x, y)));
}

export function usePartyLocation(): PartyLocationState {
  const [position, setPosition] = useState<Coordinates | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [speed, setSpeed] = useState<number | null>(null);
  const [battery, setBattery] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isTracking, setIsTracking] = useState(false);
  const headingRef = useRef<number | null>(null);

  // --- GPS position -------------------------------------------------------
  useEffect(() => {
    let subscription: Location.LocationSubscription | null = null;
    let cancelled = false;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      if (status !== 'granted') {
        setError('Location permission was denied.');
        setIsTracking(false);
        return;
      }
      try {
        subscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Highest,
            // Matches the web app's broadcast tuning: new fix every ~4 m of
            // movement, at most every 2 s.
            distanceInterval: 4,
            timeInterval: 2000,
          },
          (loc) => {
            setPosition({ lat: loc.coords.latitude, lng: loc.coords.longitude });
            setAccuracy(loc.coords.accuracy ?? null);
            const s = loc.coords.speed;
            setSpeed(s != null && s >= 0 ? s : null);
            setIsTracking(true);
            setError(null);
          },
        );
      } catch {
        if (!cancelled) {
          setError('Unable to read your location.');
          setIsTracking(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, []);

  // --- Compass heading ----------------------------------------------------
  // The magnetometer can fire many times per second; smooth the readings and
  // commit state at most every 500 ms instead of re-rendering on each tick.
  useEffect(() => {
    let subscription: { remove: () => void } | null = null;
    let cancelled = false;
    let lastCommit = 0;

    (async () => {
      const available = await Magnetometer.isAvailableAsync().catch(() => false);
      if (cancelled || !available) return;
      Magnetometer.setUpdateInterval(500);
      subscription = Magnetometer.addListener(({ x, y }) => {
        if (x == null || y == null) return;
        const h = magnetometerToHeading(x, y);
        const prev = headingRef.current;
        const smoothed = prev == null ? h : lerpAngle(prev, h, 0.3);
        headingRef.current = smoothed;
        const now = Date.now();
        if (now - lastCommit >= 500) {
          lastCommit = now;
          setHeading(smoothed);
        }
      });
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, []);

  // --- Battery ------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const level = await Battery.getBatteryLevelAsync();
        if (!cancelled && typeof level === 'number' && level >= 0) setBattery(level);
      } catch {
        /* Battery API unsupported — leave as null */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // One-shot GPS refresh, e.g. after returning from the background where the
  // watcher was throttled. Failures keep the last known fix silently.
  const refreshPosition = useCallback(() => {
    (async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
        setPosition({ lat: loc.coords.latitude, lng: loc.coords.longitude });
        setAccuracy(loc.coords.accuracy ?? null);
        const s = loc.coords.speed;
        setSpeed(s != null && s >= 0 ? s : null);
        setIsTracking(true);
        setError(null);
      } catch {
        /* keep last known fix */
      }
    })();
  }, []);

  return {
    position,
    accuracy,
    heading,
    speed,
    battery,
    error,
    isTracking,
    refreshPosition,
  };
}
