import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import MapView, { Marker, Polyline, type Region } from 'react-native-maps';
import { acceptFriendRoute, getFriendRaceStatus, type FriendRaceStatus } from '@/lib/raceService';
import { acceptStrangerRoute, getStrangerRaceStatus, type StrangerRaceStatus } from '@/lib/strangerRaceService';
import { createRoutePreview, type RoutePreview } from '@/lib/routeService';
import { getOwnRoute } from '@/lib/raceProgressService';
import { ProfileServiceError } from '@/lib/profileService';

const colors = {
  paper: '#F4F0E8', paperDeep: '#E9E2D7', ink: '#292722', muted: '#706B63',
  vermilion: '#E24B35', line: '#C9C0B3', white: '#FFFEFC', green: '#4E6A54',
};

type StartPoint = { latitude: number; longitude: number };

type Props = {
  raceId: string;
  mode?: 'friends' | 'strangers';
  getAccessToken: () => Promise<string | null>;
  onBack?: () => void;
  /** Rendered as a step inside the race screen: no page chrome or back button. */
  embedded?: boolean;
  onAccepted?: () => void;
};

function errorCopy(error: unknown) {
  const code = error instanceof ProfileServiceError ? error.code : '';
  if (code === 'route_provider_not_configured') return 'The route service needs its OpenRouteService key configured.';
  if (code === 'route_provider_quota') return 'The route provider is busy. Try again in a little while.';
  if (code === 'route_distance_unavailable') return 'The route provider returned a path too short to build this race distance. Move the pin to a nearby street and try again.';
  if (code === 'route_distance_mismatch') return 'Both routes must be close to the agreed distance. Regenerate the route that is too long or short.';
  if (code === 'race_not_ready_for_routes') return 'Waiting for both runners to join before creating routes.';
  if (code === 'route_missing') return 'Generate your route before accepting it.';
  if (code === 'verification_required') return 'Complete your Selfie Check before creating a route.';
  if (code === 'not_a_race_participant') return 'Your account is not part of this friend race.';
  if (code === 'not_configured') return 'The race service is not configured on this build.';
  return 'Couldn’t load the route. Check your connection and try again.';
}

export default function RoutePicker({ raceId, mode = 'friends', getAccessToken, onBack, embedded = false, onAccepted }: Props) {
  const [start, setStart] = useState<StartPoint | null>(null);
  const [route, setRoute] = useState<RoutePreview | null>(null);
  const [raceStatus, setRaceStatus] = useState<FriendRaceStatus | StrangerRaceStatus | null>(null);
  const [busy, setBusy] = useState<'location' | 'route' | 'accept' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refreshStatus = useCallback(async () => {
    const accessToken = await getAccessToken();
    if (!accessToken) return;
    const status = mode === 'strangers'
      ? await getStrangerRaceStatus(accessToken, raceId) : await getFriendRaceStatus(accessToken, raceId);
    setRaceStatus(status);
  }, [getAccessToken, mode, raceId]);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const accessToken = await getAccessToken();
        if (!accessToken || !active) return;
        const status = mode === 'strangers'
          ? await getStrangerRaceStatus(accessToken, raceId) : await getFriendRaceStatus(accessToken, raceId);
        if (active) setRaceStatus(status);
      } catch {
        // Preserve the last confirmed state during short network interruptions.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [getAccessToken, mode, raceId]);

  // Reopen the route this runner already generated instead of asking for a new start.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const token = await getAccessToken();
        const saved = token ? await getOwnRoute(token, raceId) : null;
        if (!active || !saved || saved.coordinates.length < 2) return;
        const [longitude, latitude] = saved.coordinates[0];
        setStart((current) => current ?? { latitude, longitude });
        setRoute((current) => current ?? saved);
      } catch { /* A fresh start is still available. */ }
    })();
    return () => { active = false; };
  }, [getAccessToken, raceId]);

  const region = useMemo<Region | undefined>(() => start ? ({
    latitude: start.latitude,
    longitude: start.longitude,
    latitudeDelta: 0.008,
    longitudeDelta: 0.008,
  }) : undefined, [start]);

  async function chooseCurrentLocation() {
    if (Platform.OS === 'android' && !process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY) {
      setError('Add a restricted Google Maps SDK key to mobile/.env, then create the next Android development build to show and adjust the start pin.');
      return;
    }
    setBusy('location');
    setError('');
    setNotice('');
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        setError('Location permission is needed to suggest your start. You can allow it in phone settings and try again.');
        return;
      }
      if (!await Location.hasServicesEnabledAsync()) {
        setError('Turn on Location in your phone’s system settings, then try again.');
        return;
      }
      let position: Location.LocationObject;
      try {
        position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      } catch (locationError) {
        const lastKnown = await Location.getLastKnownPositionAsync({ maxAge: 15 * 60 * 1000, requiredAccuracy: 1000 }).catch(() => null);
        if (!lastKnown) throw locationError;
        position = lastKnown;
        setNotice('Using a recent location. Move the pin to your actual, safe start before generating a route.');
      }
      setStart({ latitude: position.coords.latitude, longitude: position.coords.longitude });
      setRoute(null);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'No position was available';
      setError(__DEV__
        ? `Couldn’t get your location: ${detail}`
        : 'Couldn’t get your location. Check that Precise location is allowed for Rivalry, then try again outdoors.');
    } finally {
      setBusy(null);
    }
  }

  async function chooseLastKnownArea() {
    setBusy('location');
    setError('');
    try {
      const saved = await Location.getLastKnownPositionAsync({ requiredAccuracy: 2000 });
      if (!saved) {
        setError('This phone has no saved location to start from. Try GPS again after stepping outdoors.');
        return;
      }
      setStart({ latitude: saved.coords.latitude, longitude: saved.coords.longitude });
      setRoute(null);
      setNotice('This saved area may be old. Move the pin to your actual, safe start before generating a route.');
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'No saved position was available';
      setError(__DEV__ ? `Couldn’t open a saved area: ${detail}` : 'Couldn’t open a saved area. Try GPS again outdoors.');
    } finally {
      setBusy(null);
    }
  }

  async function generateRoute(forceRefresh = false) {
    if (!start) return;
    setBusy('route');
    setError('');
    setNotice('');
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new ProfileServiceError('No active Privy token.', 'unauthorized', 401);
      const preview = await createRoutePreview(accessToken, raceId, start.latitude, start.longitude, forceRefresh);
      setRoute(preview);
      await refreshStatus();
    } catch (cause) {
      setError(errorCopy(cause));
    } finally {
      setBusy(null);
    }
  }

  async function acceptRoute() {
    setBusy('accept');
    setError('');
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new ProfileServiceError('No active Privy token.', 'unauthorized', 401);
      const result = mode === 'strangers'
        ? await acceptStrangerRoute(accessToken, raceId) : await acceptFriendRoute(accessToken, raceId);
      setNotice(result.status === 'ready'
        ? 'Both routes are accepted. Your race is ready for its start setup.'
        : `Route accepted. Waiting for your ${mode === 'strangers' ? 'opponent' : 'friend'} to finish reviewing their route.`);
      await refreshStatus();
      onAccepted?.();
    } catch (cause) {
      setError(errorCopy(cause));
    } finally {
      setBusy(null);
    }
  }

  const otherParticipant = raceStatus?.participants.find((participant) => !participant.isSelf);
  const acceptedByMe = raceStatus?.participants.find((participant) => participant.isSelf)?.routeAccepted ?? false;
  const bothRoutesAccepted = raceStatus?.status === 'ready' || raceStatus?.status === 'verification';
  const targetMeters = (raceStatus?.distanceKm ?? route?.targetDistanceKm ?? 0) * 1000;
  // Routes are trimmed to the exact preset; the server accepts within 5 m.
  const distanceTolerance = 5;
  const myDistanceIsOff = route !== null && targetMeters > 0 && Math.abs(route.distanceMeters - targetMeters) > distanceTolerance;
  const otherDistanceIsOff = otherParticipant?.routeDistanceMeters != null && targetMeters > 0 &&
    Math.abs(otherParticipant.routeDistanceMeters - targetMeters) > distanceTolerance;
  const routeGapIsOff = route !== null && otherParticipant?.routeDistanceMeters != null &&
    Math.abs(route.distanceMeters - otherParticipant.routeDistanceMeters) > distanceTolerance;
  const distancesMatch = !myDistanceIsOff && !otherDistanceIsOff && !routeGapIsOff;
  const coordinates = route?.coordinates.map(([longitude, latitude]) => ({ latitude, longitude })) ?? [];
  // A trimmed loop finishes on the route just before it would return to the start.
  const lastPoint = coordinates[coordinates.length - 1];
  const finishPoint = lastPoint && coordinates.length > 1 &&
    Math.hypot(lastPoint.latitude - coordinates[0].latitude, (lastPoint.longitude - coordinates[0].longitude) * Math.cos(lastPoint.latitude * Math.PI / 180)) * 111_320 > 30
    ? lastPoint : null;
  const turnaround = route?.routeShape === 'out_and_back'
    ? coordinates[route.loopRepeats === 2 ? Math.floor((coordinates.length + 1) / 4) : Math.floor(coordinates.length / 2)]
    : null;
  const profile = route?.elevationProfile ?? [];
  const minElevation = profile.length ? Math.min(...profile.map((point) => point.elevationMeters)) : 0;
  const maxElevation = profile.length ? Math.max(...profile.map((point) => point.elevationMeters)) : 0;
  const bars = profile.length > 1 ? Array.from({ length: 24 }, (_, index) => {
    const item = profile[Math.round(index * (profile.length - 1) / 23)];
    const spread = Math.max(1, maxElevation - minElevation);
    return Math.max(12, 18 + ((item.elevationMeters - minElevation) / spread) * 54);
  }) : [];
  const missingAndroidMapsKey = Platform.OS === 'android' && !process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;

  const body = (
      <>
        {!embedded ? (
          <>
            <View style={styles.topbar}>
              <Pressable accessibilityRole="button" onPress={onBack} style={styles.backButton}><Text style={styles.backLabel}>‹ RACES</Text></Pressable>
              <Text style={styles.wordmark}>RIVALRY</Text>
            </View>
            <Text style={styles.eyebrow}>ROUTE REVIEW · {raceStatus?.distanceKm ?? '—'} KM</Text>
            <Text accessibilityRole="header" style={styles.title}>{bothRoutesAccepted ? 'Routes accepted.' : 'Choose a safe start.'}</Text>
          </>
        ) : null}
        <Text style={styles.copy}>{bothRoutesAccepted
          ? 'Both runners approved their routes. This race is ready for start coordination.'
          : 'We’ll build a route near you. Your start point goes to our route provider and stays private to this race.'}</Text>

        {!bothRoutesAccepted && !start ? (
          <View style={styles.locationPrompt}>
            <Text style={styles.locationPromptTitle}>START NEAR YOU</Text>
            <Text style={styles.locationPromptCopy}>{missingAndroidMapsKey
              ? 'Android needs its restricted Maps SDK key before the map can show your location or let you move the start pin.'
              : 'Use GPS to find a nearby start, then move the pin to a safe, accessible spot.'}</Text>
            <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => void chooseCurrentLocation()} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy !== null && styles.disabled]}>
              {busy === 'location' ? <ActivityIndicator color={colors.white} /> : <Text style={styles.primaryButtonLabel}>Use my current location</Text>}
            </Pressable>
          </View>
        ) : start ? (
          <View style={styles.mapFrame}>
            {region ? (
              <MapView
                accessibilityLabel="Map for choosing a safe route start"
                initialRegion={region}
                onPress={(event) => { setStart(event.nativeEvent.coordinate); setRoute(null); }}
                style={styles.map}
              >
                {coordinates.length > 1 ? <Polyline coordinates={coordinates} strokeColor={colors.vermilion} strokeWidth={5} /> : null}
                {turnaround ? <Marker coordinate={turnaround} pinColor={colors.green} title="Turn around" description="Follow the same path back to the start" /> : null}
                {finishPoint ? <Marker coordinate={finishPoint} pinColor={colors.ink} title="Finish" description="Your exact race distance ends here" /> : null}
                <Marker
                  coordinate={start}
                  draggable
                  pinColor={colors.vermilion}
                  onDragEnd={(event) => { setStart(event.nativeEvent.coordinate); setRoute(null); }}
                  title="Race start"
                  description="Drag to a safe nearby start point"
                />
              </MapView>
            ) : null}
            <View style={styles.mapCaption}><Text style={styles.mapCaptionText}>TAP MAP OR DRAG PIN TO ADJUST</Text></View>
          </View>
        ) : null}

        {missingAndroidMapsKey && !bothRoutesAccepted ? <Text style={styles.mapSetupNotice}>Set `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` in mobile/.env before the next Android development build. The key should be restricted to the Rivalry package and build signing fingerprint.</Text> : null}

        {route ? (
          <View style={styles.routeCard}>
            <View style={styles.statsRow}>
              <View><Text style={styles.statLabel}>ROUTE</Text><Text style={styles.statValue}>{(route.distanceMeters / 1000).toFixed(2)} km</Text></View>
              <View><Text style={styles.statLabel}>ELEVATION GAIN</Text><Text style={styles.statValue}>{Math.round(route.elevationGainMeters)} m</Text></View>
              {route.loopRepeats === 2 ? <View><Text style={styles.statLabel}>10 KM ROUTE</Text><Text style={styles.statValue}>5 km × 2</Text></View> : null}
            </View>
            <Text style={styles.profileTitle}>ELEVATION PROFILE</Text>
            <View accessibilityLabel="Elevation profile" style={styles.elevationBars}>
              {bars.map((height, index) => <View key={index} style={[styles.elevationBar, { height }]} />)}
            </View>
            <View style={styles.profileScale}><Text style={styles.scaleText}>START</Text><Text style={styles.scaleText}>FINISH</Text></View>
            <Text style={styles.profileFootnote}>Total elevation gain is the main difficulty score. Both runners can see the difference and accept their own route.</Text>
            {route.routeShape === 'out_and_back' ? <Text style={styles.profileFootnote}>Out-and-back route: turn around at the far end and follow the same path to the start.</Text> : null}
          </View>
        ) : null}

        {route && raceStatus ? (
          <View style={styles.opponentCard}>
            <Text style={styles.panelEyebrow}>ROUTE CHECK</Text>
            {otherParticipant?.elevationGainMeters === null || !otherParticipant ? (
              <Text style={styles.opponentText}>Waiting for your {mode === 'strangers' ? 'opponent' : 'friend'} to generate their route.</Text>
            ) : (
              <Text style={styles.opponentText}>Your {mode === 'strangers' ? 'opponent' : 'friend'}’s route: {((otherParticipant.routeDistanceMeters ?? 0) / 1000).toFixed(2)} km · {Math.round(otherParticipant.elevationGainMeters ?? 0)} m elevation gain.</Text>
            )}
            {!distancesMatch ? <Text style={styles.distanceWarning}>{myDistanceIsOff
              ? 'Your route is outside the agreed distance. Regenerate it from this start or move the pin.'
              : otherDistanceIsOff ? 'Your friend’s route is outside the agreed distance. Ask them to regenerate it.'
                : 'The two routes are too different in length. Regenerate a route before accepting.'}</Text> : null}
            <Text style={styles.opponentStatus}>{bothRoutesAccepted
              ? 'BOTH ROUTES ACCEPTED'
              : otherParticipant?.routeAccepted ? 'OPPONENT ACCEPTED' : 'WAITING FOR OPPONENT REVIEW'}</Text>
          </View>
        ) : null}

        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {error && !start ? (
          <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => void chooseLastKnownArea()} style={styles.textButton}>
            <Text style={styles.textButtonLabel}>Choose a start from my saved area</Text>
          </Pressable>
        ) : null}
        {bothRoutesAccepted || notice ? <Text accessibilityRole="alert" style={styles.notice}>{bothRoutesAccepted
          ? 'Both routes are accepted. Return to the race screen to continue.'
          : notice}</Text> : null}

        {start && !route && !bothRoutesAccepted ? (
          <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => void generateRoute()} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy !== null && styles.disabled]}>
            {busy === 'route' ? <ActivityIndicator color={colors.white} /> : <Text style={styles.primaryButtonLabel}>Generate my route</Text>}
          </Pressable>
        ) : null}
        {route && raceStatus?.status === 'route_review' ? (
          <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => void generateRoute(true)} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy !== null && styles.disabled]}>
            {busy === 'route' ? <ActivityIndicator color={colors.white} /> : <Text style={styles.primaryButtonLabel}>Regenerate my route</Text>}
          </Pressable>
        ) : null}
        {route && !acceptedByMe && distancesMatch ? (
          <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => void acceptRoute()} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy !== null && styles.disabled]}>
            {busy === 'accept' ? <ActivityIndicator color={colors.white} /> : <Text style={styles.primaryButtonLabel}>Accept this route</Text>}
          </Pressable>
        ) : null}
        {bothRoutesAccepted && onBack ? (
          <Pressable accessibilityRole="button" onPress={onBack} style={styles.primaryButton}>
            <Text style={styles.primaryButtonLabel}>Back to race</Text>
          </Pressable>
        ) : null}
        {start && !bothRoutesAccepted ? <Pressable accessibilityRole="button" onPress={() => { setStart(null); setRoute(null); setError(''); }} style={styles.textButton}><Text style={styles.textButtonLabel}>Choose another start</Text></Pressable> : null}
        <Text style={styles.privacyNote}>{mode === 'strangers' ? 'Your opponent sees route distance, elevation, and race progress. Your location stays private.' : 'Your friend sees your route profile and progress. Exact start coordinates stay private.'}</Text>
      </>
  );

  if (embedded) return <View>{body}</View>;
  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>{body}</ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.paper },
  content: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 12, paddingBottom: 34 },
  topbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 30 },
  backButton: { minHeight: 40, justifyContent: 'center', paddingRight: 18 },
  backLabel: { color: colors.vermilion, fontSize: 11, fontWeight: '900', letterSpacing: 1.1 },
  wordmark: { color: colors.ink, fontSize: 14, fontWeight: '900', letterSpacing: 2.2 },
  eyebrow: { color: colors.vermilion, fontSize: 10, fontWeight: '900', letterSpacing: 1.6, marginBottom: 10 },
  title: { color: colors.ink, fontFamily: 'serif', fontSize: 37, lineHeight: 42, letterSpacing: -1.1 },
  copy: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 10, marginBottom: 20 },
  locationPrompt: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, padding: 18, marginBottom: 17 },
  locationPromptTitle: { color: colors.ink, fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  locationPromptCopy: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 8, marginBottom: 17 },
  mapFrame: { height: 330, overflow: 'hidden', backgroundColor: colors.paperDeep, marginBottom: 16, borderWidth: 1, borderColor: colors.line },
  map: { flex: 1 },
  mapCaption: { position: 'absolute', left: 10, right: 10, bottom: 10, alignItems: 'center', backgroundColor: colors.white, padding: 9 },
  mapCaptionText: { color: colors.ink, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  mapSetupNotice: { color: '#775B29', backgroundColor: '#F6E8C9', padding: 12, fontSize: 12, lineHeight: 17, marginBottom: 14 },
  routeCard: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, padding: 16, marginBottom: 14 },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  statLabel: { color: colors.muted, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  statValue: { color: colors.ink, fontFamily: 'serif', fontSize: 20, fontWeight: '700', marginTop: 5 },
  profileTitle: { color: colors.muted, fontSize: 9, fontWeight: '900', letterSpacing: 1.3, marginTop: 20 },
  elevationBars: { height: 75, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 3, borderBottomWidth: 1, borderColor: colors.line, marginTop: 7 },
  elevationBar: { flex: 1, backgroundColor: colors.vermilion, opacity: 0.76, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  profileScale: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
  scaleText: { color: colors.muted, fontSize: 8, fontWeight: '800', letterSpacing: 0.8 },
  profileFootnote: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 10 },
  opponentCard: { backgroundColor: colors.paperDeep, padding: 14, marginBottom: 15 },
  panelEyebrow: { color: colors.muted, fontSize: 9, fontWeight: '900', letterSpacing: 1.3 },
  opponentText: { color: colors.ink, fontSize: 13, lineHeight: 19, marginTop: 8 },
  opponentStatus: { color: colors.green, fontSize: 9, fontWeight: '900', letterSpacing: 1, marginTop: 10 },
  distanceWarning: { color: '#A42F20', fontSize: 12, lineHeight: 18, marginTop: 10 },
  primaryButton: { minHeight: 52, backgroundColor: colors.vermilion, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  primaryButtonLabel: { color: colors.white, fontSize: 14, fontWeight: '800', letterSpacing: 0.2 },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.45 },
  textButton: { alignItems: 'center', minHeight: 46, justifyContent: 'center', marginTop: 7 },
  textButtonLabel: { color: colors.vermilion, fontSize: 12, fontWeight: '800' },
  error: { color: '#A42F20', backgroundColor: '#F8E4DF', padding: 12, fontSize: 12, lineHeight: 17, marginBottom: 12 },
  notice: { color: colors.green, backgroundColor: '#E6ECE4', padding: 12, fontSize: 12, lineHeight: 17, marginBottom: 12 },
  privacyNote: { color: colors.muted, fontSize: 10, lineHeight: 15, textAlign: 'center', marginTop: 14 },
});
