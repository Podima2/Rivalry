import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getFriendRaceStatus, leaveFriendRace, setFriendStartReady, type FriendRaceStatus } from '@/lib/raceService';
import { getActiveStrangerRace, getStrangerRaceStatus, leaveStrangerRace, setStrangerStartReady, type StrangerRaceStatus } from '@/lib/strangerRaceService';
import { ProfileServiceError } from '@/lib/profileService';
import MatchCelebration from '@/components/MatchCelebration';
import RaceLive from '@/components/RaceLive';
import RoutePicker from '@/components/RoutePicker';
import WorldVerificationTest from '@/components/WorldVerificationTest';

const colors = {
  paper: '#F4F0E8', paperDeep: '#E9E2D7', ink: '#292722', muted: '#706B63',
  vermilion: '#E24B35', line: '#C9C0B3', white: '#FFFEFC', green: '#4E6A54',
};

type Mode = 'friends' | 'strangers';
type Status = FriendRaceStatus | StrangerRaceStatus;
type Participant = Status['participants'][number] & { selfieVerified?: boolean };

type Props = {
  mode: Mode;
  raceId: string;
  /** Four-digit code, known only to the friend who created the invite. */
  inviteCode: string | null;
  selfHandle: string;
  /** Celebrate if this phone's own join/queue call produced the match. */
  celebrateIfMatched: boolean;
  initialNotice?: string;
  getAccessToken: () => Promise<string | null>;
  /** The race is over for this phone: left, cancelled, or results dismissed. */
  onExit: (notice?: string) => void;
  /** A cancelled stranger match returned this runner to the queue as a new race. */
  onRaceChanged: (raceId: string, notice: string) => void;
};

// One celebration per race, even if the screen remounts.
const celebratedRaces = new Set<string>();
const PRE_START = ['route_review', 'ready', 'verification'];

function formatClock(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function SearchingPulse() {
  const pulse = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <View style={styles.searchStage}>
      <Animated.View style={[styles.searchRing, {
        opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] }),
        transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1.8] }) }],
      }]} />
      <View style={styles.searchDot} />
    </View>
  );
}

function Step({ index, title, state, summary, children }: {
  index: number; title: string; state: 'done' | 'current' | 'locked'; summary?: string; children?: ReactNode;
}) {
  return (
    <View style={[styles.step, state === 'current' && styles.stepCurrent]}>
      <View style={styles.stepHeader}>
        <View style={[styles.stepBadge, state === 'done' && styles.stepBadgeDone, state === 'current' && styles.stepBadgeCurrent]}>
          <Text style={[styles.stepBadgeText, state !== 'locked' && styles.stepBadgeTextOn]}>{state === 'done' ? '✓' : index}</Text>
        </View>
        <Text style={[styles.stepTitle, state === 'locked' && styles.stepTitleLocked]}>{title}</Text>
      </View>
      {summary ? <Text style={styles.stepSummary}>{summary}</Text> : null}
      {state === 'current' && children ? <View style={styles.stepBody}>{children}</View> : null}
    </View>
  );
}

export default function RaceFlow({
  mode, raceId, inviteCode, selfHandle, celebrateIfMatched, initialNotice, getAccessToken, onExit, onRaceChanged,
}: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [notice, setNotice] = useState(initialNotice ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'ready' | 'leave' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [showMatch, setShowMatch] = useState(false);
  const previousStatus = useRef<string | null>(null);
  // Parent callbacks change identity every render; keep polling stable.
  const callbacks = useRef({ onExit, onRaceChanged, celebrateIfMatched });
  useEffect(() => { callbacks.current = { onExit, onRaceChanged, celebrateIfMatched }; });

  const fetchStatus = useCallback(async (): Promise<Status | null> => {
    const token = await getAccessToken();
    if (!token) return null;
    return mode === 'strangers' ? getStrangerRaceStatus(token, raceId) : getFriendRaceStatus(token, raceId);
  }, [getAccessToken, mode, raceId]);

  const applyStatus = useCallback(async (next: Status) => {
    const { onExit, onRaceChanged, celebrateIfMatched } = callbacks.current;
    if (next.status === 'cancelled') {
      if (mode === 'strangers') {
        const token = await getAccessToken();
        const requeued = token ? await getActiveStrangerRace(token).catch(() => null) : null;
        if (requeued && requeued !== raceId) {
          onRaceChanged(requeued, 'Your match was cancelled because your opponent didn’t verify or declined. You’re back in the queue.');
          return;
        }
        onExit('That match was cancelled.');
        return;
      }
      onExit('That friend race was cancelled.');
      return;
    }
    const matchedNow = next.status !== 'waiting_for_opponent' && next.participants.length === 2 &&
      (previousStatus.current === 'waiting_for_opponent' || (previousStatus.current === null && celebrateIfMatched && next.status === 'route_review'));
    if (matchedNow && !celebratedRaces.has(raceId)) {
      celebratedRaces.add(raceId);
      setShowMatch(true);
    }
    previousStatus.current = next.status;
    setStatus(next);
  }, [getAccessToken, mode, raceId]);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchStatus();
      if (next) { await applyStatus(next); setError(''); }
    } catch {
      setError('Race status is temporarily unavailable. Retrying…');
    }
  }, [applyStatus, fetchStatus]);

  const handedToLive = status?.status === 'active' || status?.status === 'completed';
  const counting = status?.status === 'countdown';

  useEffect(() => {
    if (handedToLive) return;
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), counting ? 1000 : 3000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [counting, handedToLive, refresh]);

  const deadline = status && 'verificationDeadline' in status ? status.verificationDeadline : null;
  const selfVerified = Boolean((status?.participants.find((participant) => participant.isSelf) as Participant | undefined)?.selfieVerified);
  const deadlineRunning = Boolean(deadline) && !selfVerified && status?.status !== 'waiting_for_opponent';
  useEffect(() => {
    if (!counting && !deadlineRunning) return;
    const timer = setInterval(() => setNow(Date.now()), counting ? 250 : 1000);
    return () => clearInterval(timer);
  }, [counting, deadlineRunning]);

  if (handedToLive) {
    return <RaceLive raceId={raceId} getAccessToken={getAccessToken} onDone={() => onExit()} />;
  }

  const self = status?.participants.find((participant) => participant.isSelf) as Participant | undefined;
  const opponent = status?.participants.find((participant) => !participant.isSelf) as Participant | undefined;
  const serverOffset = status?.serverTime ? Date.parse(status.serverTime) - status.receivedAt : 0;
  const serverNow = now + serverOffset;
  const distanceKm = status?.distanceKm;

  async function setReady(ready: boolean) {
    setBusy('ready');
    setError('');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('No session');
      if (mode === 'strangers') await setStrangerStartReady(token, raceId, ready);
      else await setFriendStartReady(token, raceId, ready);
      await refresh();
    } catch (cause) {
      const code = cause instanceof ProfileServiceError ? cause.code : '';
      setError(code === 'verification_required' ? 'Complete your Selfie Check before confirming the start.'
        : code === 'race_not_ready_for_start' ? 'Both routes need to be accepted first.'
          : 'Couldn’t update your start confirmation. Check the connection and retry.');
    } finally { setBusy(null); }
  }

  async function leave() {
    setBusy('leave');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('No session');
      if (mode === 'strangers') await leaveStrangerRace(token, raceId);
      else await leaveFriendRace(token, raceId);
      onExit(mode === 'strangers'
        ? status?.status === 'waiting_for_opponent' ? 'You left the stranger queue.' : 'You declined the match. Your opponent returns to the queue.'
        : 'You called off the race.');
    } catch {
      setError('Couldn’t leave this race. Check the connection and retry.');
      setBusy(null);
    }
  }

  const header = (
    <View style={styles.topbar}>
      <Text style={styles.wordmark}>RIVALRY</Text>
      <Text style={styles.modeLabel}>{mode === 'strangers' ? 'OPEN MATCH' : 'FRIEND RACE'}{distanceKm ? ` · ${distanceKm} KM` : ''}</Text>
    </View>
  );

  if (!status) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.content}>{header}<ActivityIndicator color={colors.vermilion} style={{ marginTop: 60 }} />
          {error ? <Text style={styles.error}>{error}</Text> : null}</View>
      </SafeAreaView>
    );
  }

  if (counting) {
    const seconds = status.scheduledStartAt ? Math.max(0, Math.ceil((Date.parse(status.scheduledStartAt) - serverNow) / 1000)) : 0;
    return (
      <SafeAreaView style={[styles.safeArea, styles.countdownScreen]}>
        <Text style={styles.countdownKicker}>YOU VS @{opponent?.handle ?? 'RUNNER'} · {distanceKm} KM</Text>
        <Text style={styles.countdownNumber}>{seconds > 0 ? seconds : 'GO'}</Text>
        <Text style={styles.countdownCopy}>Starting together, wherever you both are. Be at your start pin.</Text>
      </SafeAreaView>
    );
  }

  const waiting = status.status === 'waiting_for_opponent';
  const strangers = mode === 'strangers';
  const selfieDone = !strangers || Boolean(self?.selfieVerified);
  const routeDone = Boolean(self?.routeAccepted);
  const readyDone = Boolean(self?.startReady);
  const bothRoutes = status.status === 'ready' || status.status === 'verification';
  const km = (meters: number | null | undefined) => meters ? `${(meters / 1000).toFixed(2)} km` : '—';
  const routeSummary = (participant?: Participant) => participant?.routeDistanceMeters
    ? `${km(participant.routeDistanceMeters)} · ${Math.round(participant.elevationGainMeters ?? 0)} m gain` : null;
  const deadlineLeft = deadline ? Date.parse(deadline) - serverNow : null;
  let stepNumber = 0;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {header}
        {waiting ? (
          strangers ? (
            <>
              <Text style={styles.eyebrow}>OPEN MATCH · {distanceKm} KM</Text>
              <Text accessibilityRole="header" style={styles.title}>Finding a runner…</Text>
              <SearchingPulse />
              <Text style={styles.copy}>Searching worldwide for someone ready to race {distanceKm} km. You stay in the queue until you’re matched or you leave.</Text>
            </>
          ) : (
            <>
              <Text style={styles.eyebrow}>FRIEND RACE · {distanceKm} KM</Text>
              <Text accessibilityRole="header" style={styles.title}>Invite your rival.</Text>
              {inviteCode ? (
                <View style={styles.codeCard}>
                  <Text style={styles.codeLabel}>INVITE CODE · EXPIRES IN 10 MIN</Text>
                  <Text accessibilityLabel={`Invite code ${inviteCode}`} selectable style={styles.code}>{inviteCode}</Text>
                  <Pressable accessibilityRole="button" onPress={() => void Share.share({ message: `Join my ${distanceKm} km Rivalry race: rivalry:///?invite=${inviteCode}` })} style={styles.secondaryButton}>
                    <Text style={styles.secondaryButtonLabel}>Share invite link</Text>
                  </Pressable>
                </View>
              ) : null}
              <SearchingPulse />
              <Text style={styles.copy}>Waiting for your friend to join. This screen continues as soon as they enter the code.</Text>
            </>
          )
        ) : (
          <>
            <Text style={styles.eyebrow}>{strangers ? 'VERIFIED STRANGER RACE' : 'FRIEND RACE'} · {distanceKm} KM</Text>
            <Text accessibilityRole="header" style={styles.title}>You vs @{opponent?.handle ?? 'runner'}</Text>
            <View style={styles.opponentRow}>
              {strangers ? <Text style={[styles.chip, opponent?.selfieVerified && styles.chipOn]}>{opponent?.selfieVerified ? '✓ ' : ''}SELFIE</Text> : null}
              <Text style={[styles.chip, opponent?.routeAccepted && styles.chipOn]}>{opponent?.routeAccepted ? '✓ ' : ''}ROUTE</Text>
              <Text style={[styles.chip, opponent?.startReady && styles.chipOn]}>{opponent?.startReady ? '✓ ' : ''}READY</Text>
              <Text style={styles.chipCaption}>@{opponent?.handle ?? 'runner'}</Text>
            </View>

            {strangers ? (
              <Step index={++stepNumber} title="Selfie Check" state={selfieDone ? 'done' : 'current'}
                summary={selfieDone ? 'Verified for this race · World ID Sandbox (simulated)'
                  : deadlineLeft !== null ? `${formatClock(deadlineLeft)} left to verify, or this match is cancelled.` : undefined}>
                <WorldVerificationTest embedded raceId={raceId} getAccessToken={getAccessToken} onVerified={() => void refresh()} />
              </Step>
            ) : null}

            <Step index={++stepNumber} title="Your route" state={routeDone ? 'done' : selfieDone ? 'current' : 'locked'}
              summary={routeDone ? `${routeSummary(self) ?? 'Accepted'}${opponent?.routeDistanceMeters ? `  ·  @${opponent.handle}: ${routeSummary(opponent)}` : ''}`
                : !selfieDone ? 'Unlocks after your Selfie Check.' : undefined}>
              <RoutePicker embedded raceId={raceId} mode={mode} getAccessToken={getAccessToken} onAccepted={() => void refresh()} />
            </Step>

            <Step index={++stepNumber} title="I’m at my start" state={readyDone ? 'done' : routeDone ? 'current' : 'locked'}
              summary={readyDone ? `Confirmed. ${opponent?.startReady ? 'Starting…' : `Waiting for @${opponent?.handle ?? 'runner'} to confirm.`}`
                : !routeDone ? 'Unlocks after you accept your route.'
                  : !bothRoutes ? `Waiting for @${opponent?.handle ?? 'runner'} to accept their route.` : 'Stand at your start pin, then confirm. The countdown begins when you’re both ready.'}>
              <Pressable accessibilityRole="button" disabled={busy !== null || !bothRoutes} onPress={() => void setReady(true)}
                style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, (busy !== null || !bothRoutes) && styles.disabled]}>
                {busy === 'ready' ? <ActivityIndicator color={colors.white} /> : <Text style={styles.primaryButtonLabel}>I’m at my start · ready</Text>}
              </Pressable>
            </Step>
            {readyDone && status.status === 'ready' ? (
              <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => void setReady(false)} style={styles.textButton}>
                <Text style={styles.textButtonLabel}>Cancel my start confirmation</Text>
              </Pressable>
            ) : null}
          </>
        )}

        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}

        {waiting || PRE_START.includes(status.status) ? (
          <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => { setNotice(''); void leave(); }} style={styles.leaveButton}>
            <Text style={styles.leaveLabel}>{busy === 'leave' ? 'Leaving…'
              : waiting ? strangers ? 'Leave the queue' : 'Cancel this invite'
                : strangers ? 'Decline this match' : 'Call off this race'}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
      <MatchCelebration visible={showMatch} mode={mode} selfHandle={selfHandle}
        opponentHandle={opponent?.handle ?? 'runner'} distanceKm={distanceKm ?? 0} onContinue={() => setShowMatch(false)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.paper },
  content: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 12, paddingBottom: 40 },
  topbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 26 },
  wordmark: { color: colors.ink, fontSize: 14, fontWeight: '900', letterSpacing: 2.2 },
  modeLabel: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.3 },
  eyebrow: { color: colors.vermilion, fontSize: 10, fontWeight: '900', letterSpacing: 1.5, marginBottom: 9 },
  title: { color: colors.ink, fontFamily: 'serif', fontSize: 36, lineHeight: 41, letterSpacing: -1 },
  copy: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 8, textAlign: 'center' },
  codeCard: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, padding: 18, marginTop: 22, alignItems: 'center' },
  codeLabel: { color: colors.vermilion, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  code: { color: colors.ink, fontSize: 44, fontWeight: '900', letterSpacing: 8, marginVertical: 10 },
  searchStage: { height: 170, alignItems: 'center', justifyContent: 'center' },
  searchRing: { position: 'absolute', width: 120, height: 120, borderRadius: 60, borderWidth: 3, borderColor: colors.vermilion },
  searchDot: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.vermilion },
  opponentRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 12, marginBottom: 18 },
  chip: { color: colors.muted, fontSize: 9, fontWeight: '900', letterSpacing: 1, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 8, paddingVertical: 5 },
  chipOn: { color: colors.white, backgroundColor: colors.green, borderColor: colors.green },
  chipCaption: { color: colors.muted, fontSize: 11, marginLeft: 2 },
  step: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, padding: 15, marginBottom: 10 },
  stepCurrent: { borderColor: colors.vermilion, borderWidth: 2, padding: 14 },
  stepHeader: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  stepBadge: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  stepBadgeDone: { backgroundColor: colors.green, borderColor: colors.green },
  stepBadgeCurrent: { backgroundColor: colors.vermilion, borderColor: colors.vermilion },
  stepBadgeText: { color: colors.muted, fontSize: 12, fontWeight: '900' },
  stepBadgeTextOn: { color: colors.white },
  stepTitle: { color: colors.ink, fontFamily: 'serif', fontSize: 21 },
  stepTitleLocked: { color: colors.muted },
  stepSummary: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 8, marginLeft: 39 },
  stepBody: { marginTop: 14 },
  primaryButton: { minHeight: 52, backgroundColor: colors.vermilion, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  primaryButtonLabel: { color: colors.white, fontSize: 14, fontWeight: '800' },
  secondaryButton: { minHeight: 46, alignSelf: 'stretch', borderWidth: 1, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonLabel: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.45 },
  textButton: { alignItems: 'center', minHeight: 44, justifyContent: 'center' },
  textButtonLabel: { color: colors.vermilion, fontSize: 12, fontWeight: '800' },
  leaveButton: { alignItems: 'center', minHeight: 48, justifyContent: 'center', marginTop: 22 },
  leaveLabel: { color: colors.muted, fontSize: 13, fontWeight: '800', textDecorationLine: 'underline' },
  notice: { color: colors.green, backgroundColor: '#E6ECE4', padding: 12, fontSize: 12, lineHeight: 17, marginTop: 12 },
  error: { color: '#A42F20', fontSize: 12, lineHeight: 17, marginTop: 12, textAlign: 'center' },
  countdownScreen: { backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30 },
  countdownKicker: { color: colors.vermilion, fontSize: 11, fontWeight: '900', letterSpacing: 1.8 },
  countdownNumber: { color: colors.white, fontFamily: 'serif', fontSize: 150, lineHeight: 170, marginVertical: 10 },
  countdownCopy: { color: '#D9D2C6', fontSize: 15, lineHeight: 22, textAlign: 'center' },
});
