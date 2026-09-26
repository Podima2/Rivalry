import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import MapView, { Circle, Marker, Polyline } from 'react-native-maps';
import { getOwnRoute } from '@/lib/raceProgressService';

const colors = { paper: '#F4F0E8', paperDeep: '#E9E2D7', ink: '#292722', muted: '#706B63', vermilion: '#E24B35', line: '#C9C0B3', white: '#FFFEFC', green: '#4E6A54' };

type Props = {
  raceId: string;
  getAccessToken: () => Promise<string | null>;
  /** Both routes accepted; false while waiting for the opponent's route. */
  canConfirm: boolean;
  waitingCopy: string;
  busy: boolean;
  onReady: () => void;
};

type Point = { latitude: number; longitude: number };

function metersBetween(a: Point, b: Point) {
  const toRadians = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRadians;
  const dLon = (b.longitude - a.longitude) * toRadians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * toRadians) * Math.cos(b.latitude * toRadians) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Start-line check: live GPS against the start pin, then one decisive READY. */
export default function ReadyStep({ raceId, getAccessToken, canConfirm, waitingCopy, busy, onReady }: Props) {
  const [route, setRoute] = useState<Point[]>([]);
  const [fix, setFix] = useState<{ point: Point; accuracy: number } | null>(null);
  const [gpsMessage, setGpsMessage] = useState('Finding your position…');
  const [override, setOverride] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      const token = await getAccessToken();
      const saved = token ? await getOwnRoute(token, raceId).catch(() => null) : null;
      if (active && saved) setRoute(saved.coordinates.map(([longitude, latitude]) => ({ latitude, longitude })));
    })();
    return () => { active = false; };
  }, [getAccessToken, raceId]);

  useEffect(() => {
    let active = true;
    let subscription: Location.LocationSubscription | null = null;
    void (async () => {
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (!permission.granted) { if (active) setGpsMessage('Allow location to check you’re at your start.'); return; }
        subscription = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, distanceInterval: 2, timeInterval: 2000 },
          (position) => {
            if (!active) return;
            setFix({ point: { latitude: position.coords.latitude, longitude: position.coords.longitude }, accuracy: position.coords.accuracy ?? 100 });
          },
        );
        if (!active) subscription.remove();
      } catch {
        if (active) setGpsMessage('Couldn’t start GPS. Check location permissions.');
      }
    })();
    return () => { active = false; subscription?.remove(); };
  }, []);

  const start = route[0] ?? null;
  const distanceToStart = start && fix ? Math.round(metersBetween(fix.point, start)) : null;
  const threshold = fix ? Math.min(75, Math.max(40, fix.accuracy + 15)) : 40;
  const atStart = distanceToStart !== null && distanceToStart <= threshold;
  const region = useMemo(() => {
    const focus = fix?.point ?? start;
    return focus ? { ...focus, latitudeDelta: 0.004, longitudeDelta: 0.004 } : undefined;
  }, [fix?.point, start]);
  const enabled = canConfirm && !busy && (atStart || override);

  return (
    <View>
      <View style={styles.mapFrame}>
        {region ? (
          <MapView style={styles.map} region={region} scrollEnabled={false} zoomEnabled={false} pitchEnabled={false} rotateEnabled={false}>
            {route.length > 1 ? <Polyline coordinates={route} strokeColor={colors.vermilion} strokeWidth={4} /> : null}
            {start ? <Marker coordinate={start} pinColor={colors.vermilion} title="Your start" /> : null}
            {fix ? <Circle center={fix.point} radius={Math.max(5, fix.accuracy)} strokeColor={colors.green} fillColor="rgba(78,106,84,0.18)" /> : null}
            {fix ? <Circle center={fix.point} radius={3} strokeColor={colors.white} fillColor={colors.green} /> : null}
          </MapView>
        ) : <View style={styles.mapPlaceholder}><ActivityIndicator color={colors.vermilion} /></View>}
        <View style={[styles.distanceTag, atStart && styles.distanceTagGood]}>
          <Text style={[styles.distanceValue, atStart && styles.distanceValueGood]}>
            {distanceToStart === null ? '—' : atStart ? 'ON THE LINE' : `${distanceToStart} M`}
          </Text>
          <Text style={[styles.distanceCaption, atStart && styles.distanceValueGood]}>
            {distanceToStart === null ? gpsMessage : atStart ? `GPS ±${Math.round(fix?.accuracy ?? 0)} m` : 'TO YOUR START'}
          </Text>
        </View>
      </View>

      <Pressable accessibilityRole="button" accessibilityState={{ disabled: !enabled }} disabled={!enabled} onPress={onReady}
        style={({ pressed }) => [styles.readyButton, !enabled && styles.readyButtonOff, pressed && styles.readyPressed]}>
        {busy ? <ActivityIndicator color={colors.white} /> : (
          <>
            <Text style={[styles.readyText, !enabled && styles.readyTextOff]}>READY</Text>
            <Text style={[styles.readyHint, !enabled && styles.readyTextOff]}>
              {!canConfirm ? waitingCopy : atStart || override ? 'Lock it in. The countdown starts when you’re both ready.' : 'Walk to your start pin to unlock.'}
            </Text>
          </>
        )}
      </Pressable>
      {canConfirm && !atStart && !override ? (
        <Pressable accessibilityRole="button" onPress={() => setOverride(true)} style={styles.overrideButton}>
          <Text style={styles.overrideText}>GPS not locking? I’m at my start</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  mapFrame: { height: 230, borderWidth: 1, borderColor: colors.line, overflow: 'hidden', backgroundColor: colors.paperDeep },
  map: { flex: 1 },
  mapPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  distanceTag: { position: 'absolute', left: 10, top: 10, backgroundColor: colors.white, paddingHorizontal: 11, paddingVertical: 8, borderLeftWidth: 3, borderLeftColor: colors.vermilion },
  distanceTagGood: { backgroundColor: colors.green, borderLeftColor: colors.white },
  distanceValue: { color: colors.ink, fontSize: 17, fontWeight: '900', letterSpacing: 0.6 },
  distanceValueGood: { color: colors.white },
  distanceCaption: { color: colors.muted, fontSize: 9, fontWeight: '800', letterSpacing: 1, marginTop: 2 },
  readyButton: { marginTop: 12, minHeight: 84, backgroundColor: colors.vermilion, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, paddingVertical: 12 },
  readyButtonOff: { backgroundColor: colors.paperDeep },
  readyPressed: { transform: [{ scale: 0.985 }], opacity: 0.92 },
  readyText: { color: colors.white, fontSize: 30, fontWeight: '900', letterSpacing: 8 },
  readyTextOff: { color: colors.muted },
  readyHint: { color: colors.white, fontSize: 11, fontWeight: '700', marginTop: 4, textAlign: 'center', opacity: 0.9 },
  overrideButton: { alignItems: 'center', minHeight: 40, justifyContent: 'center' },
  overrideText: { color: colors.muted, fontSize: 11, fontWeight: '700', textDecorationLine: 'underline' },
});
