import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getFriendRaceStatus, leaveFriendRace, setFriendStartReady, type FriendRaceStatus } from '@/lib/raceService';
import { getActiveStrangerRace, getStrangerRaceStatus, leaveStrangerRace, setStrangerStartReady, type StrangerRaceStatus } from '@/lib/strangerRaceService';
import { ProfileServiceError } from '@/lib/profileService';
import MatchCelebration from '@/components/MatchCelebration';
import RaceLive from '@/components/RaceLive';
import ReadyStep from '@/components/ReadyStep';
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
    <View style={[styles.step, state === 'current' && styles.stepCurrent, state === 'done' && styles.stepDone]}>
      <View style={styles.stepHeader}>
        <Text style={[styles.stepNumber, state === 'current' && styles.stepNumberCurrent, state === 'done' && styles.stepNumberDone]}>
          {state === 'done' ? '✓' : index.toString().padStart(2, '0')}
        </Text>
        <View style={styles.flex}>
          <Text style={[styles.stepTitle, state === 'locked' && styles.stepTitleLocked]}>{title}</Text>
          {summary ? <Text style={styles.stepSummary}>{summary}</Text> : null}
        </View>
      </View>
      {state === 'current' && children ? <View style={styles.stepBody}>{children}</View> : null}
    </View>
  );
}

/** A race bib: the runner's handle, their side, and their start-line checklist. */
function Bib({ handle, side, checks }: { handle: string; side: 'you' | 'rival'; checks: { label: string; done: boolean }[] }) {
  return (
    <View style={styles.bib}>
      <View style={[styles.bibStrip, side === 'rival' && styles.bibStripRival]}>
        <Text style={styles.bibStripText}>{side === 'you' ? 'YOU' : 'RIVAL'}</Text>
      </View>
      {[styles.pinTopLeft, styles.pinTopRight, styles.pinBottomLeft, styles.pinBottomRight].map((position, index) => (
        <View key={index} style={[styles.pin, position]} />
      ))}
      <Text numberOfLines={1} adjustsFontSizeToFit style={styles.bibHandle}>@{handle}</Text>
      <View style={styles.bibChecks}>
        {checks.map((check) => (
          <Text key={check.label} style={[styles.bibCheck, check.done && styles.bibCheckDone]}>{check.done ? '●' : '○'} {check.label}</Text>
        ))}
      </View>
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
              <Text accessibilityRole="header" style={styles.title}>Call out your rival.</Text>
              {inviteCode ? (
                <View style={styles.codeCard}>
                  <View style={styles.ticketNotchLeft} />
                  <View style={styles.ticketNotchRight} />
                  <Text style={styles.codeLabel}>RACE ENTRY CODE · VALID 10 MIN</Text>
                  <Text accessibilityLabel={`Invite code ${inviteCode}`} selectable style={styles.code}>{inviteCode}</Text>
                  <View style={styles.ticketRule} />
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
            <Text style={styles.eyebrow}>{strangers ? 'VERIFIED OPEN MATCH' : 'FRIEND RACE'} · {distanceKm} KM</Text>
            <View accessible accessibilityLabel={`You versus @${opponent?.handle ?? 'runner'}`} style={styles.matchup}>
              <Bib handle={self?.handle ?? selfHandle} side="you" checks={[
                ...(strangers ? [{ label: 'SELFIE', done: selfieDone }] : []),
                { label: 'ROUTE', done: routeDone }, { label: 'READY', done: readyDone },
              ]} />
              <Text style={styles.versus}>vs</Text>
              <Bib handle={opponent?.handle ?? 'runner'} side="rival" checks={[
                ...(strangers ? [{ label: 'SELFIE', done: Boolean(opponent?.selfieVerified) }] : []),
                { label: 'ROUTE', done: Boolean(opponent?.routeAccepted) }, { label: 'READY', done: Boolean(opponent?.startReady) },
              ]} />
            </View>
            <Text style={styles.stakes}>{distanceKm} KM · SAME START TIME · FASTEST VERIFIED TIME WINS</Text>
            <Text style={styles.checklistLabel}>START LINE CHECKLIST</Text>

            {strangers ? (
              <Step index={++stepNumber} title="Selfie Check" state={selfieDone ? 'done' : 'current'}
                summary={selfieDone ? 'Verified for this race with World ID'
                  : deadlineLeft !== null ? `${formatClock(deadlineLeft)} left to verify, or this match is cancelled.` : undefined}>
                <WorldVerificationTest embedded raceId={raceId} getAccessToken={getAccessToken} onVerified={() => void refresh()} />
              </Step>
            ) : null}

            <Step index={++stepNumber} title="Your route" state={routeDone ? 'done' : selfieDone ? 'current' : 'locked'}
              summary={routeDone ? `${routeSummary(self) ?? 'Accepted'}${opponent?.routeDistanceMeters ? `  ·  @${opponent.handle}: ${routeSummary(opponent)}` : ''}`
                : !selfieDone ? 'Unlocks after your Selfie Check.' : undefined}>
              <RoutePicker embedded raceId={raceId} mode={mode} getAccessToken={getAccessToken} onAccepted={() => void refresh()} />
            </Step>

            <Step index={++stepNumber} title="On the start line" state={readyDone ? 'done' : routeDone ? 'current' : 'locked'}
              summary={readyDone ? `Locked in. ${opponent?.startReady ? 'Starting…' : `Waiting for @${opponent?.handle ?? 'runner'}.`}`
                : !routeDone ? 'Unlocks after you accept your route.' : 'Get to your start pin, then hit READY.'}>
              <ReadyStep raceId={raceId} getAccessToken={getAccessToken} canConfirm={bothRoutes} busy={busy === 'ready'}
                waitingCopy={`Waiting for @${opponent?.handle ?? 'runner'} to accept their route.`}
                onReady={() => void setReady(true)} />
            </Step>
            {readyDone && status.status === 'ready' ? (
              <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => void setReady(false)} style={styles.textButton}>
                <Text style={styles.textButtonLabel}>Not ready yet · undo</Text>
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
  codeCard: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, padding: 18, marginTop: 22, alignItems: 'center', overflow: 'hidden' },
  ticketNotchLeft: { position: 'absolute', left: -11, top: '50%', width: 22, height: 22, borderRadius: 11, backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.line },
  ticketNotchRight: { position: 'absolute', right: -11, top: '50%', width: 22, height: 22, borderRadius: 11, backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.line },
  ticketRule: { alignSelf: 'stretch', borderTopWidth: 1, borderStyle: 'dashed', borderColor: colors.line, marginBottom: 14 },
  codeLabel: { color: colors.vermilion, fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  code: { color: colors.ink, fontFamily: 'serif', fontSize: 58, fontWeight: '700', letterSpacing: 10, marginVertical: 8 },
  flex: { flex: 1 },
  matchup: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  versus: { color: colors.vermilion, fontFamily: 'serif', fontStyle: 'italic', fontSize: 26, marginHorizontal: 8 },
  bib: { flex: 1, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, paddingBottom: 12, alignItems: 'center' },
  bibStrip: { alignSelf: 'stretch', backgroundColor: colors.vermilion, paddingVertical: 5, alignItems: 'center' },
  bibStripRival: { backgroundColor: colors.ink },
  bibStripText: { color: colors.white, fontSize: 10, fontWeight: '900', letterSpacing: 2.4 },
  pin: { position: 'absolute', width: 7, height: 7, borderRadius: 4, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper },
  pinTopLeft: { left: 7, top: 30 },
  pinTopRight: { right: 7, top: 30 },
  pinBottomLeft: { left: 7, bottom: 7 },
  pinBottomRight: { right: 7, bottom: 7 },
  bibHandle: { color: colors.ink, fontFamily: 'serif', fontSize: 22, fontWeight: '700', marginTop: 14, paddingHorizontal: 16 },
  bibChecks: { marginTop: 9, gap: 3, alignItems: 'flex-start' },
  bibCheck: { color: colors.muted, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  bibCheckDone: { color: colors.green },
  stakes: { color: colors.muted, fontSize: 9, fontWeight: '900', letterSpacing: 1.3, textAlign: 'center', marginTop: 12 },
  checklistLabel: { color: colors.ink, fontSize: 10, fontWeight: '900', letterSpacing: 1.8, marginTop: 24, marginBottom: 9, borderBottomWidth: 2, borderBottomColor: colors.ink, paddingBottom: 6 },
  searchStage: { height: 170, alignItems: 'center', justifyContent: 'center' },
  searchRing: { position: 'absolute', width: 120, height: 120, borderRadius: 60, borderWidth: 3, borderColor: colors.vermilion },
  searchDot: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.vermilion },
  step: { borderBottomWidth: 1, borderBottomColor: colors.line, paddingVertical: 14 },
  stepCurrent: { backgroundColor: colors.white, borderLeftWidth: 4, borderLeftColor: colors.vermilion, paddingHorizontal: 12, borderBottomColor: 'transparent', marginVertical: 4 },
  stepDone: { opacity: 0.85 },
  stepHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  stepNumber: { width: 34, color: colors.line, fontFamily: 'serif', fontSize: 24, fontWeight: '700', lineHeight: 28 },
  stepNumberCurrent: { color: colors.vermilion },
  stepNumberDone: { color: colors.green },
  stepTitle: { color: colors.ink, fontFamily: 'serif', fontSize: 21, lineHeight: 28 },
  stepTitleLocked: { color: colors.muted },
  stepSummary: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 3 },
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
