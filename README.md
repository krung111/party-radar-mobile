# Party Radar Mobile

Real-time party finder for iOS and Android — find your crew on a live map. Join a room with a code, see everyone moving in real time, drop waypoint pings, and route to each other or to a shared meetup point.

This is the mobile companion to the [Party Radar web app](https://github.com/krung111/party-radar). **Web and mobile players share rooms live**: join the same room code on both and everyone sees everyone.

100% free and open-source. No paid services, no API keys, no closed-source dependencies.

## Features

- **Live squad map** — OpenStreetMap tiles via MapLibre Native (no API keys), your position plus every party member, updating live
- **Compass heading** — marker wedge shows which way you're facing (magnetometer, smoothed)
- **Waypoint pings** — long-press the map to drop a ping for the whole party (2 s cooldown, 60 s TTL); tap your own ping to remove it for everyone
- **Routing** — tap a member or ping to get walking/driving directions via the free OSRM demo server; automatic dashed straight-line fallback with RETRY if the route service is unreachable
- **Meet in the middle** — propose a midpoint meetup; every device plans its own route to it
- **Join dedupe** — callsigns and marker colors are made unique automatically
- **Presence grace period** — members don't flicker out on flaky connections
- **Follow mode** — camera tracks you until you pan the map yourself

## The free stack

| Piece | What | Cost |
|---|---|---|
| App framework | Expo (React Native, TypeScript) | Free |
| Map | MapLibre Native + OpenStreetMap tiles | Free, no keys |
| Sync | Supabase Realtime (broadcast + presence, no tables) | Free tier |
| Routing | OSRM public demo server | Free, keyless |
| Builds | EAS Build (free tier) | Free |

## Setup

### 1. Environment

```sh
cp .env.example .env
```

Fill in `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` — use the **same values as the web app** so both clients share rooms.

### 2. Install dependencies

Always use `npx expo install` (resolves SDK-compatible versions):

```sh
npx expo install expo-router react-native-safe-area-context react-native-screens \
  expo-linking expo-constants expo-status-bar \
  expo-location expo-sensors expo-battery expo-crypto expo-clipboard \
  @supabase/supabase-js @maplibre/maplibre-react-native
npx expo install --fix
```

### 3. Run it

This app uses native modules (MapLibre), so it needs a **development build** — it won't run in Expo Go:

```sh
# cloud build (no Xcode / Android Studio needed)
npx eas-cli@latest build --profile development

# or locally
npx expo run:android
npx expo run:ios
```

Then `npx expo start --dev-client`.

### 4. Typecheck & lint

```sh
npx tsc --noEmit
npx expo lint
```

## Project structure

```
src/
  app/
    _layout.tsx      # Expo Router stack (dark theme)
    index.tsx        # Join screen: room code + callsign + color
    room.tsx         # Live map HUD: markers, pings, routes, meetup, roster
  components/
    MemberList.tsx   # Squad roster strip
  hooks/
    usePartySync.ts      # Supabase Realtime: broadcast, presence, pings, routing, meetup
    usePartyLocation.ts  # expo-location + magnetometer heading + battery
  lib/
    supabase.ts   # Realtime client + channel/event conventions (shared with web)
    geo.ts        # Great-circle math (shared with web)
    routing.ts    # OSRM client with cache + typed errors (shared with web)
    mapStyle.ts   # Key-free OSM raster style for MapLibre
  types/
    party.ts      # Domain types + payload shapes (shared with web)
```

The `lib/` and `types/` modules are ported 1:1 from the web app — same channel names (`party:<roomId>`), same event names, same payloads. That's what makes web ↔ mobile interop work.

## Room codes

Room codes are uppercase, max 12 characters. Anyone with the code joins — no accounts, no invites.

## Roadmap

- Background location tracking (currently foreground only)
- The web app's circular radar HUD as an alternate view
- Offline map packs for areas with no signal (MapLibre OfflineManager)

## License

MIT — same as the web app.
