import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import MapView, { Circle, Marker, Polyline, type Region } from 'react-native-maps';
import { forfeitRace, getRaceProgress, sendRaceLocation, type RaceProgressSnapshot } from '@/lib/raceProgressService';
import { ProfileServiceError } from '@/lib/profileService';

const colors = {
  paper: '#F4F0E8', white: '#FFFEFC', ink: '#292722', muted: '#706B63', line: '#C9C0B3',
  vermilion: '#E24B35', green: '#4E6A54', yellow: '#A3721F',
};

type Props = { raceId: string; getAccessToken: () => Promise<string | null>; onBack: () => void };

function routeRegion(coordinates: [number, number, number][]): Region {
  const latitude = coordinates.map((coordinate) => coordinate[1]);
  const longitude = coordinates.map((coordinate) => coordinate[0]);
  const minLatitude = Math.min(...latitude);
  const maxLatitude = Math.max(...latitude);
  const minLongitude = Math.min(...longitude);
  const maxLongitude = Math.max(...longitude);
  return {
    latitude: (minLatitude + maxLatitude) / 2,
    longitude: (minLongitude + maxLongitude) / 2,
    latitudeDelta: Math.max(0.005, (maxLatitude - minLatitude) * 1.35),
    longitudeDelta: Math.max(0.005, (maxLongitude - minLongitude) * 1.35),
  };
}

function formatTime(milliseconds: number | null) {
  if (milliseconds === null) return '—';
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function formatDistance(meters: number) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${meters} m`;
}

export default function RaceLive({ raceId, getAccessToken, onBack }: Props) {
  const [snapshot, setSnapshot] = useState<RaceProgressSnapshot | null>(null);
  const [locationState, setLocationState] = useState('Connecting to GPS…');
  const [error, setError] = useState('');
  const [quitting, setQuitting] = useState(false);
  const [currentFix, setCurrentFix] = useState<{ latitude: number; longitude: number; accuracy: number } | null>(null);
  const [mapFocus, setMapFocus] = useState<'location' | 'route'>('location');
  const lastSentAt = useRef(0);
  const sending = useRef(false);
  const running = snapshot?.status === 'active' && snapshot.participants.find((participant) => participant.isSelf)?.state === 'running';

  const refresh = useCallback(async () => {
    const accessToken = await getAccessToken();
    if (!accessToken) return;
    const next = await getRaceProgress(accessToken, raceId);
    setSnapshot(next);
  }, [getAccessToken, raceId]);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const accessToken = await getAccessToken();
        if (!accessToken || !active) return;
        const next = await getRaceProgress(accessToken, raceId);
        if (active) { setSnapshot(next); setError(''); }
      } catch {
        if (active) setError('Race progress is temporarily unavailable. Retrying…');
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 4000);
    return () => { active = false; clearInterval(timer); };
  }, [getAccessToken, raceId]);

  useEffect(() => {
    if (!running) return;
    let active = true;
    let subscription: Location.LocationSubscription | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const publishPosition = (position: Location.LocationObject) => {
      if (active) setCurrentFix({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy ?? 100,
      });
      if (!active || sending.current || Date.now() - lastSentAt.current < 3500) return;
      lastSentAt.current = Date.now();
      sending.current = true;
      void (async () => {
        try {
          const token = await getAccessToken();
          if (!token || !active) return;
          const result = await sendRaceLocation(token, raceId, position.coords.latitude,
            position.coords.longitude, position.coords.accuracy ?? 100);
          if (!active) return;
          setLocationState(result.waitingForStart
            ? `Head to your start pin${result.distanceFromStartMeters !== null ? ` · ${formatDistance(result.distanceFromStartMeters)} away` : ''}. The clock is already running.`
            : result.onRoute === false
              ? `Off route${result.distanceFromRouteMeters !== null ? ` · ${formatDistance(result.distanceFromRouteMeters)} from your planned route` : ''}. The clock keeps running.`
              : `GPS recording · ${Math.round(position.coords.accuracy ?? 0)} m accuracy`);
          if (result.state === 'finished' || result.state === 'completed') await refresh();
        } catch (cause) {
          if (!active) return;
          const code = cause instanceof ProfileServiceError ? cause.code : '';
          setLocationState(code === 'location_inaccurate'
            ? 'GPS signal is too weak. Move into an open area; the clock keeps running.'
            : 'Couldn’t send your location. Check your connection; the clock keeps running.');
        } finally {
          sending.current = false;
        }
      })();
    };
    const start = async () => {
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (!permission.granted) {
          setLocationState('Location permission is off. Enable Precise location for Rivalry to record this run.');
          return;
        }
        if (!await Location.hasServicesEnabledAsync()) {
          setLocationState('Turn on system Location to record this run.');
          return;
        }
        subscription = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, distanceInterval: 5, timeInterval: 5000 },
          publishPosition,
          () => { if (active) setLocationState('GPS signal lost. The clock keeps running.'); },
        );
        if (!active) { subscription.remove(); return; }
        void Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
          .then(publishPosition).catch(() => undefined);
        heartbeat = setInterval(() => {
          void Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
            .then(publishPosition)
            .catch(() => { if (active) setLocationState('GPS signal lost. The clock keeps running.'); });
        }, 20_000);
      } catch {
        if (active) setLocationState('Couldn’t start GPS tracking. Check location permissions.');
      }
    };
    void start();
    return () => { active = false; subscription?.remove(); if (heartbeat) clearInterval(heartbeat); };
  }, [getAccessToken, raceId, refresh, running]);

  const self = snapshot?.participants.find((participant) => participant.isSelf);
  const friend = snapshot?.participants.find((participant) => !participant.isSelf);
  const isStrangerRace = snapshot?.mode === 'strangers';
  const coordinates = useMemo(() => snapshot?.ownRoute.map((point) => ({ latitude: point[1], longitude: point[0] })) ?? [], [snapshot]);
  const region = useMemo(() => snapshot?.ownRoute?.length ? routeRegion(snapshot.ownRoute) : null, [snapshot]);
  const ownPosition = currentFix ?? (self?.latestLocation ? {
    latitude: self.latestLocation.latitude,
    longitude: self.latestLocation.longitude,
    accuracy: self.latestLocation.accuracy_m,
  } : null);
  const shownRegion: Region | null = mapFocus === 'location' && ownPosition ? {
    latitude: ownPosition.latitude,
    longitude: ownPosition.longitude,
    latitudeDelta: 0.008,
    longitudeDelta: 0.008,
  } : region;
  const resultAtRisk = self?.state === 'running' && self.offRouteMs + self.gpsGapMs > 0
    ? `Result at risk · ${Math.round(self.offRouteMs / 1000)}s off route (limit 60s), longest GPS gap ${Math.round(self.longestGpsGapMs / 1000)}s (limit 120s).`
    : null;
  const endedCopy = (participant: typeof self, who: string) => participant?.dnfReason === 'inactive'
    ? `${who} sent no GPS for 10 minutes, so the race recorded a DNF.`
    : participant?.dnfReason === 'time_limit' ? `${who} passed the race time limit, so the race recorded a DNF.`
      : null;
  const friendFix = friend?.latestLocation;
  const friendFixAgeSeconds = friendFix && snapshot
    ? Math.max(0, Math.floor((snapshot.receivedAt - Date.parse(friendFix.captured_at)) / 1000)) : null;

  function confirmQuit() {
    Alert.alert('End your race?', `This will record a DNF. Your ${isStrangerRace ? 'opponent' : 'friend'} can keep running.`, [
      { text: 'Keep running', style: 'cancel' },
      { text: 'End race', style: 'destructive', onPress: () => void (async () => {
        setQuitting(true);
        try {
          const token = await getAccessToken();
          if (!token) throw new Error('No access token');
          await forfeitRace(token, raceId);
          await refresh();
        } catch { setError('Couldn’t end your race. Check the connection and try again.'); }
        finally { setQuitting(false); }
      })() },
    ]);
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.topbar}>
          <Pressable accessibilityRole="button" onPress={onBack}><Text style={styles.back}>← RACE HOME</Text></Pressable>
          <Text style={styles.wordmark}>RIVALRY</Text>
        </View>
        <Text style={styles.eyebrow}>{snapshot?.status === 'completed' ? 'RACE RESULT' : `LIVE ${isStrangerRace ? 'STRANGER' : 'FRIEND'} RACE · ${snapshot?.distanceKm ?? '—'} KM`}</Text>
        <Text accessibilityRole="header" style={styles.title}>{snapshot?.status === 'completed'
          ? self?.outcome === 'win' ? 'You won.' : self?.outcome === 'draw' ? 'It’s a draw.' : self?.outcome === 'loss' ? `Your ${isStrangerRace ? 'opponent' : 'friend'} won.` : self?.outcome === 'dnf' ? 'Race ended.' : self?.outcome === 'invalid' ? 'Result not verified.' : 'Race finished.'
          : self?.state === 'finished' ? 'Finish reached.' : self?.state === 'dnf' ? 'Race ended.' : 'Run your route.'}</Text>
        <Text style={styles.copy}>{snapshot?.status === 'completed'
          ? `${endedCopy(self, 'You') ?? (self?.outcome === 'invalid' ? 'Your GPS track had too much time off route or without signal to verify the finish. ' : '')}${endedCopy(friend, `@${friend?.handle ?? 'Your opponent'}`) ? `${endedCopy(friend, `@${friend?.handle ?? 'Your opponent'}`)} ` : ''}Both runners are done. Precise GPS points were deleted after the result was saved.`
          : self?.state === 'finished' ? `Your time: ${formatTime(self.elapsedMs)}. Waiting for @${friend?.handle ?? 'your opponent'} to finish.`
            : self?.state === 'dnf' ? `DNF recorded. @${friend?.handle ?? 'Your opponent'} can keep running.`
            : isStrangerRace ? 'Keep Rivalry open for live GPS updates. Your opponent sees progress, never your position.'
              : 'Keep Rivalry open for live GPS updates. Your friend can see your current position and progress.'}</Text>

        {snapshot ? (
          <View style={styles.stats}>
            {[self, friend].filter(Boolean).map((participant) => participant && (
              <View key={participant.handle} style={styles.runnerRow}>
                <View style={styles.runnerTop}>
                  <Text style={styles.runnerName}>{participant.isSelf ? 'YOU' : `@${participant.handle}`}</Text>
                  <Text style={styles.runnerValue}>{participant.state === 'dnf' ? 'DNF' : participant.state === 'finished'
                    ? formatTime(participant.elapsedMs) : `${(participant.progressMeters / 1000).toFixed(2)} / ${(participant.routeDistanceMeters / 1000).toFixed(2)} km`}</Text>
                </View>
                <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.min(100, Math.round(participant.progressMeters / Math.max(1, participant.routeDistanceMeters) * 100))}%` }]} /></View>
                {participant.outcome ? <Text style={styles.result}>{participant.outcome.toUpperCase()}</Text> : null}
              </View>
            ))}
          </View>
        ) : <ActivityIndicator color={colors.vermilion} />}

        {self?.state === 'running' ? <Text accessibilityRole="alert" style={[styles.gpsState, locationState.includes('recording') && styles.gpsGood]}>{locationState}</Text> : null}
        {resultAtRisk ? <Text style={styles.gpsState}>{resultAtRisk}</Text> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}

        {region && coordinates.length > 1 ? (
          <View style={styles.mapCard}>
            <Text style={styles.mapLabel}>{mapFocus === 'location' && ownPosition ? 'YOUR CURRENT LOCATION' : 'YOUR PLANNED ROUTE'}</Text>
            <View style={styles.mapActions}>
              <Pressable accessibilityRole="button" accessibilityState={{ selected: mapFocus === 'location' }} onPress={() => setMapFocus('location')} style={styles.mapAction}>
                <Text style={styles.mapActionText}>Show my location</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityState={{ selected: mapFocus === 'route' }} onPress={() => setMapFocus('route')} style={styles.mapAction}>
                <Text style={styles.mapActionText}>Show route</Text>
              </Pressable>
            </View>
            {ownPosition ? <Text style={styles.positionAge}>GPS accuracy about {Math.round(ownPosition.accuracy)} m. Green pin is your phone’s position.</Text> : null}
            <MapView style={styles.map} region={shownRegion ?? region} scrollEnabled={false} zoomEnabled={false}>
              <Polyline coordinates={coordinates} strokeColor={colors.vermilion} strokeWidth={4} />
              <Circle center={coordinates[0]} radius={7} strokeColor={colors.vermilion} fillColor={colors.vermilion} />
              {ownPosition ? <Circle center={{ latitude: ownPosition.latitude, longitude: ownPosition.longitude }} radius={Math.max(ownPosition.accuracy, 5)} strokeColor={colors.green} fillColor="rgba(78,106,84,0.15)" /> : null}
              {ownPosition ? <Marker coordinate={{ latitude: ownPosition.latitude, longitude: ownPosition.longitude }} title="Your current GPS position" pinColor={colors.green} /> : null}
            </MapView>
          </View>
        ) : null}
        {!isStrangerRace ? <View style={styles.mapCard}>
          <Text style={styles.mapLabel}>@{friend?.handle ?? 'FRIEND'} · {friendFixAgeSeconds !== null && friendFixAgeSeconds > 30 ? 'LAST POSITION' : 'LIVE POSITION'}</Text>
          {friendFixAgeSeconds !== null ? <Text style={styles.positionAge}>Updated {friendFixAgeSeconds < 60 ? `${friendFixAgeSeconds}s` : `${Math.floor(friendFixAgeSeconds / 60)}m`} ago</Text> : null}
          {friendFix ? (
            <MapView style={styles.friendMap} region={{ latitude: friendFix.latitude, longitude: friendFix.longitude, latitudeDelta: 0.006, longitudeDelta: 0.006 }} scrollEnabled={false} zoomEnabled={false}>
              <Marker coordinate={{ latitude: friendFix.latitude, longitude: friendFix.longitude }} title={`@${friend?.handle ?? 'friend'}`} />
            </MapView>
          ) : <Text style={styles.emptyMap}>Waiting for your friend’s first GPS update.</Text>}
        </View> : null}

        {self?.state === 'running' ? (
          <Pressable accessibilityRole="button" disabled={quitting} onPress={confirmQuit} style={styles.quitButton}>
            <Text style={styles.quitText}>{quitting ? 'Ending race…' : 'End my race · DNF'}</Text>
          </Pressable>
        ) : null}
        <Text style={styles.footnote}>Live tracking currently requires Rivalry to stay in the foreground. GPS gaps and route deviations keep the clock running. More than 60s off route, a GPS gap over 2 minutes, or 10 minutes without GPS (a DNF) means the result can’t be verified.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 36 },
  topbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 },
  back: { color: colors.vermilion, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  wordmark: { color: colors.ink, fontSize: 14, fontWeight: '900', letterSpacing: 2 },
  eyebrow: { color: colors.vermilion, fontSize: 10, fontWeight: '900', letterSpacing: 1.3 },
  title: { color: colors.ink, fontFamily: 'serif', fontSize: 38, lineHeight: 43, marginTop: 9 },
  copy: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 11, marginBottom: 18 },
  stats: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, padding: 16 },
  runnerRow: { marginBottom: 16 },
  runnerTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  runnerName: { color: colors.ink, fontSize: 11, fontWeight: '900' },
  runnerValue: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  progressTrack: { height: 8, backgroundColor: colors.paper, marginTop: 9 },
  progressFill: { height: 8, backgroundColor: colors.vermilion },
  result: { color: colors.green, fontSize: 10, fontWeight: '900', marginTop: 7 },
  gpsState: { color: colors.yellow, backgroundColor: '#F6E8C9', padding: 12, fontSize: 12, marginTop: 14 },
  gpsGood: { color: colors.green, backgroundColor: '#E9F0E8' },
  error: { color: '#A42F20', fontSize: 12, marginTop: 12 },
  mapCard: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, padding: 12, marginTop: 15 },
  mapLabel: { color: colors.ink, fontSize: 10, fontWeight: '900', letterSpacing: 1, marginBottom: 10 },
  mapActions: { flexDirection: 'row', gap: 9, marginBottom: 10 },
  mapAction: { borderWidth: 1, borderColor: colors.line, paddingHorizontal: 10, paddingVertical: 8 },
  mapActionText: { color: colors.ink, fontSize: 11, fontWeight: '800' },
  map: { height: 300 },
  friendMap: { height: 190 },
  emptyMap: { color: colors.muted, fontSize: 12, paddingVertical: 24 },
  positionAge: { color: colors.muted, fontSize: 11, marginBottom: 8 },
  quitButton: { borderWidth: 1, borderColor: colors.vermilion, alignItems: 'center', padding: 15, marginTop: 20 },
  quitText: { color: colors.vermilion, fontWeight: '800', fontSize: 13 },
  footnote: { color: colors.muted, fontSize: 11, lineHeight: 17, marginTop: 20 },
});
