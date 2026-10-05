/**
 * Squad roster strip: name, live distance, status tag, battery.
 */
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { memberStatus } from '@/types/party';
import type { MemberStatus, PartyMember } from '@/types/party';
import { formatDistance, haversineMeters } from '@/lib/geo';

const STATUS_STYLE: Record<MemberStatus, { color: string; borderColor: string }> = {
  moving: { color: '#6ee7b7', borderColor: '#065f46' },
  idle: { color: '#94a3b8', borderColor: '#334155' },
  stale: { color: '#fca5a5', borderColor: '#7f1d1d' },
};

interface MemberListProps {
  members: PartyMember[];
  origin: PartyMember | null;
}

export default function MemberList({ members, origin }: MemberListProps) {
  // Re-render periodically so STALE tags flip without waiting for a broadcast.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);

  if (members.length === 0) {
    return (
      <Text style={styles.empty}>No squad members yet — share the room code to bring them in.</Text>
    );
  }

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {members.map((m) => {
        const st = memberStatus(m);
        const dist = origin ? haversineMeters(origin.position, m.position) : null;
        const ss = STATUS_STYLE[st];
        return (
          <View key={m.id} style={styles.chip}>
            <View
              style={[styles.dot, { backgroundColor: m.color, shadowColor: m.color }]}
            />
            <Text style={styles.name}>{m.name}</Text>
            <Text style={styles.dist}>{dist != null ? formatDistance(dist) : '—'}</Text>
            <View style={[styles.tag, { borderColor: ss.borderColor }]}>
              <Text style={[styles.tagText, { color: ss.color }]}>{st.toUpperCase()}</Text>
            </View>
            {m.battery != null && (
              <Text style={styles.battery}>{Math.round(m.battery * 100)}%</Text>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  empty: { paddingVertical: 4, textAlign: 'center', fontSize: 12, color: '#64748b' },
  row: { gap: 8, paddingBottom: 2 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 10,
    backgroundColor: 'rgba(15,23,42,0.5)',
    paddingHorizontal: 12,
    paddingVertical: 7,
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
  name: { fontSize: 12, fontWeight: '700', color: '#e2e8f0' },
  dist: { fontSize: 10, color: '#94a3b8', letterSpacing: 1 },
  tag: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  tagText: { fontSize: 9, letterSpacing: 1.5, fontWeight: '700' },
  battery: { fontSize: 10, color: '#64748b' },
});
