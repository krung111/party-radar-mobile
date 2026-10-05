/**
 * Supabase client singleton + Realtime channel conventions.
 *
 * The app uses ONLY Supabase Realtime:
 *  - Broadcast events (`member-update`, `ping`, `ping-remove`, `meetup-share`,
 *    `meetup-clear`) for position/waypoint/meetup sync.
 *  - Presence for join/leave roster tracking.
 * No database tables are required, so this works on the free tier out of the box.
 *
 * Auth persistence is disabled on purpose: the app never signs in, it only
 * opens realtime channels with the public anon key — the same credentials the
 * Party Radar web app uses, so web and mobile clients share rooms live.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. ' +
        'Copy .env.example to .env and fill in your Supabase project credentials.',
    );
  }
  cached = createClient(url, key, {
    auth: {
      // Realtime-only app: no sign-in, no session to persist or refresh.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return cached;
}

/** One Realtime channel per party room, e.g. `party:AB12C`. */
export const partyChannelName = (roomId: string): string => `party:${roomId}`;

export const BroadcastEvent = {
  MEMBER_UPDATE: 'member-update',
  PING: 'ping',
  PING_REMOVE: 'ping-remove',
  MEETUP_SHARE: 'meetup-share',
  MEETUP_CLEAR: 'meetup-clear',
} as const;
