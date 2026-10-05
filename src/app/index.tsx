/**
 * Join screen: room code + callsign + marker color → pushes to /room.
 */
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { MEMBER_COLORS } from '@/types/party';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(): string {
  let s = '';
  for (let i = 0; i < 5; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

export default function JoinScreen() {
  const [roomId, setRoomId] = useState('');
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(
    MEMBER_COLORS[Math.floor(Math.random() * MEMBER_COLORS.length)],
  );

  const canJoin = roomId.trim().length > 0 && name.trim().length > 0;

  const goRoom = (code: string, callsign: string) => {
    router.push({
      pathname: '/room',
      params: {
        roomId: code.trim().toUpperCase().slice(0, 12),
        name: callsign.trim().slice(0, 16),
        color,
      },
    });
  };

  const onJoin = () => {
    if (!canJoin) return;
    goRoom(roomId, name);
  };

  const onCreateParty = () => {
    if (!name.trim()) return;
    goRoom(randomCode(), name);
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.kicker}>SQUAD UPLINK</Text>
          <Text style={styles.title}>Party Radar</Text>
          <Text style={styles.subtitle}>Real-time party finder for your crew</Text>

          <Text style={styles.label}>CALLSIGN</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Vex"
            placeholderTextColor="#475569"
            maxLength={16}
            autoCorrect={false}
            style={styles.input}
          />

          <Text style={styles.label}>MARKER COLOR</Text>
          <View style={styles.swatches}>
            {MEMBER_COLORS.map((c) => (
              <Pressable
                key={c}
                onPress={() => setColor(c)}
                accessibilityLabel={`Marker color ${c}`}
                style={[
                  styles.swatch,
                  {
                    backgroundColor: c,
                    borderColor: color === c ? '#fff' : 'transparent',
                    shadowColor: c,
                    opacity: color === c ? 1 : 0.65,
                    transform: [{ scale: color === c ? 1.15 : 1 }],
                  },
                ]}
              />
            ))}
          </View>

          <Pressable
            onPress={onCreateParty}
            disabled={!name.trim()}
            style={[styles.deploy, !name.trim() && styles.deployDisabled]}
          >
            <Text style={styles.deployText}>CREATE PARTY</Text>
          </Pressable>

          <View style={styles.orRow}>
            <View style={styles.orLine} />
            <Text style={styles.orText}>OR</Text>
            <View style={styles.orLine} />
          </View>

          <View style={styles.joinRow}>
            <TextInput
              value={roomId}
              onChangeText={(t) => setRoomId(t.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              placeholder="ROOM CODE"
              placeholderTextColor="#475569"
              maxLength={12}
              autoCapitalize="characters"
              autoCorrect={false}
              style={[styles.input, styles.joinInput]}
            />
            <Pressable
              onPress={onJoin}
              disabled={!canJoin}
              style={[styles.joinBtn, !canJoin && styles.deployDisabled]}
            >
              <Text style={styles.joinBtnText}>JOIN</Text>
            </Pressable>
          </View>

          <Text style={styles.hint}>
            The app will ask for location access.{'\n'}
            Share the room code so your party can join — web players at the same code see you live.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#04060c' },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  card: {
    borderWidth: 1,
    borderColor: 'rgba(34,211,238,0.25)',
    borderRadius: 16,
    backgroundColor: '#060a13',
    padding: 24,
  },
  kicker: {
    fontSize: 10,
    letterSpacing: 3,
    color: '#22d3ee',
    fontWeight: '700',
  },
  title: { marginTop: 4, fontSize: 28, fontWeight: '800', color: '#f1f5f9' },
  subtitle: { marginTop: 2, fontSize: 13, color: '#64748b' },
  label: {
    marginTop: 20,
    fontSize: 11,
    letterSpacing: 1.5,
    color: '#94a3b8',
    fontWeight: '600',
  },
  input: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 8,
    backgroundColor: 'rgba(15,23,42,0.6)',
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: '#f1f5f9',
    fontSize: 16,
  },
  swatches: { marginTop: 10, flexDirection: 'row', gap: 12 },
  swatch: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    shadowOpacity: 0.6,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  deploy: {
    marginTop: 28,
    borderRadius: 8,
    backgroundColor: '#0891b2',
    paddingVertical: 14,
    alignItems: 'center',
  },
  deployDisabled: { opacity: 0.4 },
  deployText: { color: '#04060c', fontWeight: '800', letterSpacing: 3, fontSize: 14 },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 16 },
  orLine: { flex: 1, height: 1, backgroundColor: '#1e293b' },
  orText: { fontSize: 10, letterSpacing: 3, color: '#475569', fontWeight: '700' },
  joinRow: { flexDirection: 'row', gap: 8 },
  joinInput: { flex: 1, marginTop: 0, letterSpacing: 3 },
  joinBtn: {
    borderWidth: 1,
    borderColor: '#0e7490',
    borderRadius: 8,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  joinBtnText: { color: '#67e8f9', fontWeight: '800', letterSpacing: 2, fontSize: 14 },
  hint: {
    marginTop: 14,
    textAlign: 'center',
    fontSize: 11,
    lineHeight: 17,
    color: '#64748b',
  },
});
