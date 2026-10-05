/**
 * Key-free, open-data map style: plain OpenStreetMap raster tiles rendered by
 * MapLibre Native. No API keys, no accounts, no paid services — the tiles are
 * served by the OSMF tile servers under their standard usage policy.
 *
 * Attribution is required by the ODbL license; the MapView renders it via
 * `attributionEnabled` (see the room screen).
 */
import type { StyleSpecification } from '@maplibre/maplibre-react-native';

export const OSM_RASTER_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    {
      id: 'osm-tiles',
      type: 'raster',
      source: 'osm',
    },
  ],
};
