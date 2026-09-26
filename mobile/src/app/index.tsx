import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Share,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLoginWithEmail, usePrivy } from '@privy-io/expo';
import { useLocalSearchParams } from 'expo-router';
import { getRunnerHandle, saveRunnerHandle } from '@/lib/runnerProfile';
import { getRemoteRunnerHandle, isProfileServiceConfigured, ProfileServiceError, reserveRemoteRunnerHandle } from '@/lib/profileService';
import { createFriendInvite, getActiveFriendRace, getFriendRaceStatus, joinFriendInvite, setFriendStartReady, type FriendRaceStatus } from '@/lib/raceService';
import RoutePicker from '@/components/RoutePicker';
import RaceLive from '@/components/RaceLive';
import WorldVerificationTest from '@/components/WorldVerificationTest';
import { getActiveStrangerRace, getStrangerRaceStatus, joinStrangerQueue, leaveStrangerRace, setStrangerStartReady, type StrangerRaceStatus } from '@/lib/strangerRaceService';

const colors = {
  paper: '#F4F0E8',
  paperDeep: '#E9E2D7',
  ink: '#292722',
  muted: '#706B63',
  vermilion: '#E24B35',
  line: '#C9C0B3',
  white: '#FFFEFC',
};

export default function HomeScreen() {
  const { invite } = useLocalSearchParams<{ invite?: string }>();
  const homeScrollRef = useRef<ScrollView>(null);
  const inviteInputFocused = useRef(false);
  const { user, isReady, error: privyError, logout, getAccessToken } = usePrivy();
  const { sendCode, loginWithCode, state } = useLoginWithEmail();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [runnerHandle, setRunnerHandle] = useState<string | null>(null);
  const [handleDraft, setHandleDraft] = useState('');
  const [loadedProfileFor, setLoadedProfileFor] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [raceMode, setRaceMode] = useState<'friends' | 'strangers'>('friends');
  const [raceDistance, setRaceDistance] = useState<1 | 3 | 5 | 10>(5);
  const [setupNotice, setSetupNotice] = useState('');
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviteDraft, setInviteDraft] = useState('');
  const [raceActionBusy, setRaceActionBusy] = useState(false);
  const [activeRaceId, setActiveRaceId] = useState<string | null>(null);
  const [activeRaceStatus, setActiveRaceStatus] = useState<FriendRaceStatus | null>(null);
  const [strangerRaceId, setStrangerRaceId] = useState<string | null>(null);
  const [strangerRaceStatus, setStrangerRaceStatus] = useState<StrangerRaceStatus | null>(null);
  const [strangerRestoreComplete, setStrangerRestoreComplete] = useState(false);
  const [openRaceMode, setOpenRaceMode] = useState<'friends' | 'strangers'>('friends');
  const [verifyingMatchedRace, setVerifyingMatchedRace] = useState(false);
  const [raceClockMs, setRaceClockMs] = useState(0);
  const [showRoutePicker, setShowRoutePicker] = useState(false);
  const [showLiveRace, setShowLiveRace] = useState(false);
  const friendLiveAutoOpened = useRef(false);
  const strangerLiveAutoOpened = useRef(false);
  const raceChosenOnThisLaunch = useRef(false);
  const modeChosenOnThisLaunch = useRef(false);
  const [showWorldVerificationTest, setShowWorldVerificationTest] = useState(false);
  const privyUserId = user?.id;
  const awaitingCode = state.status === 'awaiting-code-input' || state.status === 'submitting-code';
  const busy = state.status === 'sending-code' || state.status === 'submitting-code';

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const subscription = Keyboard.addListener('keyboardDidShow', () => {
      if (inviteInputFocused.current) homeScrollRef.current?.scrollToEnd({ animated: true });
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    raceChosenOnThisLaunch.current = false;
    modeChosenOnThisLaunch.current = false;
  }, [privyUserId]);

  useEffect(() => {
    if (typeof invite !== 'string' || !/^\d{4}$/.test(invite)) return;
    const timer = setTimeout(() => {
      modeChosenOnThisLaunch.current = true;
      setRaceMode('friends');
      setInviteDraft(invite);
      setShowRoutePicker(false);
      setShowLiveRace(false);
      setSetupNotice('Friend invite link opened. Sign in if needed, then tap Join with code.');
    }, 0);
    return () => clearTimeout(timer);
  }, [invite]);

  useEffect(() => {
    if (!privyUserId) return;

    let cancelled = false;
    const loadHandle = async () => {
      if (isProfileServiceConfigured()) {
        const accessToken = await getAccessToken();
        if (!accessToken) throw new Error('No active Privy access token.');
        const remoteHandle = await getRemoteRunnerHandle(accessToken);
        if (remoteHandle) {
          // Supabase is authoritative; a device cache failure must not hide a saved profile.
          await saveRunnerHandle(privyUserId, remoteHandle).catch(() => undefined);
        }
        return remoteHandle;
      }
      return getRunnerHandle(privyUserId);
    };

    loadHandle()
      .then((storedHandle) => {
        if (!cancelled) {
          setRunnerHandle(storedHandle);
          setHandleDraft(storedHandle ?? '');
          setLoadedProfileFor(privyUserId);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProfileError('Couldn’t load the runner name saved on this phone.');
          setLoadedProfileFor(privyUserId);
        }
      });

    return () => { cancelled = true; };
  }, [getAccessToken, privyUserId]);

  useEffect(() => {
    if (!privyUserId || !isProfileServiceConfigured()) return;
    let active = true;
    const restoreRace = async () => {
      try {
        const accessToken = await getAccessToken();
        if (!accessToken) return;
        const race = await getActiveFriendRace(accessToken);
        if (!active || !race || raceChosenOnThisLaunch.current) return;
        if (!modeChosenOnThisLaunch.current) setRaceMode('friends');
        setActiveRaceId(race.raceId);
      } catch {
        // Keep the home screen usable if race restoration is briefly unavailable.
      }
    };
    void restoreRace();
    return () => { active = false; };
  }, [getAccessToken, privyUserId]);

  useEffect(() => {
    if (!activeRaceId || showRoutePicker) return;
    let active = true;
    const refresh = async () => {
      try {
        const accessToken = await getAccessToken();
        if (!accessToken) return;
        const status = await getFriendRaceStatus(accessToken, activeRaceId);
        if (!active) return;
        if (status.status === 'cancelled') {
          setActiveRaceId(null);
          setActiveRaceStatus(null);
          setInviteCode(null);
          setSetupNotice('That friend race was cancelled. Create or join a new invite to race again.');
          return;
        }
        setActiveRaceStatus(status);
        // Both runners land in the results lobby, including after a restart.
        if ((status.status === 'active' || status.status === 'completed') && !friendLiveAutoOpened.current && strangerRestoreComplete && !strangerRaceId && raceMode === 'friends') {
          friendLiveAutoOpened.current = true;
          setOpenRaceMode('friends');
          setShowLiveRace(true);
        }
      } catch {
        // Keep the invite available while the race service is briefly offline.
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => { active = false; clearInterval(timer); };
  }, [activeRaceId, getAccessToken, raceMode, showRoutePicker, strangerRaceId, strangerRestoreComplete]);

  useEffect(() => {
    if (!privyUserId || !isProfileServiceConfigured()) return;
    let active = true;
    void (async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        const raceId = await getActiveStrangerRace(token);
        if (active && raceId) {
          setStrangerRaceId(raceId);
          if (!modeChosenOnThisLaunch.current) setRaceMode('strangers');
        }
      } catch { /* Keep the home screen usable while matching is unavailable. */ }
      finally { if (active) setStrangerRestoreComplete(true); }
    })();
    return () => { active = false; };
  }, [getAccessToken, privyUserId]);

  useEffect(() => {
    if (!strangerRaceId || (showRoutePicker && openRaceMode === 'strangers')) return;
    let active = true;
    const refresh = async () => {
      try {
        const token = await getAccessToken();
        if (!token || !active) return;
        const status = await getStrangerRaceStatus(token, strangerRaceId);
        if (!active) return;
        if (status.status === 'cancelled') {
          const nextRaceId = await getActiveStrangerRace(token);
          if (!active) return;
          setStrangerRaceId(nextRaceId);
          setStrangerRaceStatus(null);
          if (nextRaceId) setSetupNotice('Your previous match ended. You are back in the stranger queue.');
          return;
        }
        setStrangerRaceStatus(status);
        if (status.status !== 'completed') setRaceDistance(status.distanceKm);
        if ((status.status === 'active' || status.status === 'completed') && !strangerLiveAutoOpened.current) {
          strangerLiveAutoOpened.current = true;
          setOpenRaceMode('strangers');
          setShowLiveRace(true);
        }
      } catch { /* Preserve the last confirmed status during a network interruption. */ }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => { active = false; clearInterval(timer); };
  }, [getAccessToken, openRaceMode, showRoutePicker, strangerRaceId]);

  useEffect(() => {
    if (activeRaceStatus?.status !== 'countdown' && activeRaceStatus?.status !== 'active' &&
        strangerRaceStatus?.status !== 'countdown' && strangerRaceStatus?.status !== 'active') return;
    const timer = setInterval(() => setRaceClockMs(Date.now()), 250);
    return () => clearInterval(timer);
  }, [activeRaceStatus?.status, strangerRaceStatus?.status]);

  async function requestCode() {
    setErrorMessage('');
    try {
      await sendCode({ email: email.trim() });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown Privy error';
      setErrorMessage(
        __DEV__ ? `Sign-in request failed: ${detail.replaceAll(email.trim(), '[email]')}` : 'We couldn’t send a sign-in code. Check the address and try again.',
      );
    }
  }

  async function submitCode() {
    setErrorMessage('');
    try {
      await loginWithCode({ email: email.trim(), code: code.trim() });
    } catch {
      setErrorMessage('That code didn’t work. Check it and try again.');
    }
  }

  if (!isReady) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loading}>
          {privyError ? (
            <>
              <Text style={styles.eyebrow}>SIGN-IN SETUP</Text>
              <Text style={styles.authTitle}>Can’t reach sign-in right now.</Text>
              <Text accessibilityRole="alert" style={styles.description}>
                Check this phone’s internet connection, then reload Rivalry.
              </Text>
            </>
          ) : (
            <>
              <ActivityIndicator color={colors.vermilion} />
              <Text style={styles.loadingText}>Getting Rivalry ready…</Text>
            </>
          )}
        </View>
      </SafeAreaView>
    );
  }

  if (user) {
    const profileUserId = user.id;
    const profileLoading = loadedProfileFor !== profileUserId;

    if (profileLoading) {
      return (
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.loading}>
            <ActivityIndicator color={colors.vermilion} />
            <Text style={styles.loadingText}>Loading your runner profile…</Text>
          </View>
        </SafeAreaView>
      );
    }

    if (!runnerHandle) {
      const normalizedHandle = handleDraft.trim().toLowerCase().replace(/^@/, '');
      const validHandle = /^[a-z0-9_]{3,20}$/.test(normalizedHandle);

      async function submitRunnerHandle() {
        if (!validHandle) return;
        setProfileSaving(true);
        setProfileError('');
        try {
          let savedHandle = normalizedHandle;
          if (isProfileServiceConfigured()) {
            const accessToken = await getAccessToken();
            if (!accessToken) throw new Error('No active Privy access token.');
            savedHandle = await reserveRemoteRunnerHandle(accessToken, normalizedHandle);
          }
          setRunnerHandle(savedHandle);
          await saveRunnerHandle(profileUserId, savedHandle).catch(() => undefined);
        } catch (error) {
          setProfileError(error instanceof ProfileServiceError && error.code === 'handle_unavailable'
            ? 'That runner name is already taken. Try another one.'
            : isProfileServiceConfigured()
              ? 'Couldn’t save your runner name to Rivalry. Check your connection and try again.'
              : 'Couldn’t save this name on the phone. Please try again.');
        } finally {
          setProfileSaving(false);
        }
      }

      return (
        <SafeAreaView style={styles.safeArea}>
          <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView contentContainerStyle={styles.profileContent} keyboardShouldPersistTaps="handled">
              <View style={styles.topbar}>
                <Text style={styles.wordmark}>RIVALRY</Text>
                <View style={styles.liveLabel}><View style={styles.liveDot} /><Text style={styles.liveText}>ACCOUNT READY</Text></View>
              </View>
              <Text style={styles.eyebrow}>YOUR RUNNER IDENTITY</Text>
              <Text accessibilityRole="header" style={styles.profileHeadline}>Choose the name they’ll see at the finish.</Text>
              <Text style={styles.description}>Pick a public runner name for your races. It should be easy to remember and share.</Text>

              <View style={styles.profilePanel}>
                <Text style={styles.panelEyebrow}>PUBLIC RUNNER NAME</Text>
                <View style={styles.handleInputRow}>
                  <Text style={styles.handleAt}>@</Text>
                  <TextInput
                    accessibilityLabel="Public runner name"
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={20}
                    onChangeText={setHandleDraft}
                    placeholder="yourname"
                    placeholderTextColor={colors.muted}
                    style={styles.handleInput}
                    value={handleDraft.replace(/^@/, '')}
                  />
                </View>
                <Text style={styles.handleHint}>3–20 characters · lowercase letters, numbers, or underscore</Text>
                {profileError ? <Text accessibilityRole="alert" style={styles.error}>{profileError}</Text> : null}
                <Pressable
                  accessibilityRole="button"
                  disabled={!validHandle || profileSaving}
                  onPress={() => void submitRunnerHandle()}
                  style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, (!validHandle || profileSaving) && styles.disabled]}
                >
                  {profileSaving ? <ActivityIndicator color={colors.white} /> : <Text style={styles.primaryButtonLabel}>Save runner name</Text>}
                </Pressable>
              </View>

              <View style={styles.demoNotice}>
                <Text style={styles.demoNoticeTitle}>{isProfileServiceConfigured() ? 'PROFILE SERVICE' : 'LOCAL DEMO PROFILE'}</Text>
                <Text style={styles.demoNoticeText}>{isProfileServiceConfigured()
                  ? 'Your runner name is reserved in Rivalry’s profile service. Its planned testnet ENS name will be added when the parent domain and registrar are configured.'
                  : 'This name is saved on this phone for now. Global availability and the planned ENS name will be connected when Rivalry’s profile service and testnet domain are configured.'}</Text>
              </View>
              <Pressable accessibilityRole="button" onPress={() => void logout()} style={styles.textButton}>
                <Text style={styles.textButtonLabel}>Sign out</Text>
              </Pressable>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      );
    }

    async function startRaceSetup() {
      setSetupNotice('');
      setInviteCode(null);
      if (raceMode === 'strangers') {
        if (raceDistance === 10) {
          setSetupNotice('10 km stranger matching is paused because this Sandbox setup cannot issue the required Official ID credential. Choose 1, 3, or 5 km.');
          return;
        }
        setRaceActionBusy(true);
        try {
          const token = await getAccessToken();
          if (!token) throw new ProfileServiceError('No active Privy token.', 'unauthorized', 401);
          const raceId = await joinStrangerQueue(token, raceDistance);
          setStrangerRaceId(raceId);
          setStrangerRaceStatus(await getStrangerRaceStatus(token, raceId));
          strangerLiveAutoOpened.current = false;
          setSetupNotice('You are in the stranger queue. Rivalry will match another runner at the same distance.');
        } catch {
          setSetupNotice('Couldn’t join stranger matching. Check the connection and try again.');
        } finally { setRaceActionBusy(false); }
        return;
      }
      if (!isProfileServiceConfigured()) {
        setSetupNotice('Friend invites need the Supabase profile and race services. Your local demo profile is ready; the invite service is not configured yet.');
        return;
      }

      setRaceActionBusy(true);
      try {
        const accessToken = await getAccessToken();
        if (!accessToken) throw new ProfileServiceError('No active Privy token.', 'unauthorized', 401);
        const invite = await createFriendInvite(accessToken, raceDistance);
        raceChosenOnThisLaunch.current = true;
        setInviteCode(invite.inviteCode);
        setActiveRaceId(invite.raceId);
        setActiveRaceStatus(null);
        friendLiveAutoOpened.current = false;
        setSetupNotice(`${invite.distanceKm} km invite created. Share this four-digit code with one friend; it expires in 10 minutes.`);
      } catch (error) {
        const code = error instanceof ProfileServiceError ? error.code : '';
        setSetupNotice(code === 'profile_required'
          ? 'Save a runner name to the profile service before creating an invite.'
          : code === 'unauthorized'
            ? 'Your sign-in session needs refreshing. Sign out and back in, then try again.'
            : 'Couldn’t create the invite. Check the connection and confirm the race service is deployed.');
      } finally {
        setRaceActionBusy(false);
      }
    }

    async function joinInvite() {
      setSetupNotice('');
      if (!isProfileServiceConfigured()) {
        setSetupNotice('Joining an invite needs the Supabase profile and race services. The code can be entered once they’re configured.');
        return;
      }

      setRaceActionBusy(true);
      try {
        const accessToken = await getAccessToken();
        if (!accessToken) throw new ProfileServiceError('No active Privy token.', 'unauthorized', 401);
        const joined = await joinFriendInvite(accessToken, inviteDraft);
        raceChosenOnThisLaunch.current = true;
        setRaceDistance(joined.distanceKm);
        setActiveRaceId(joined.raceId);
        setActiveRaceStatus(null);
        friendLiveAutoOpened.current = false;
        setSetupNotice('You joined the friend race. Next, both runners choose safe starts and review their routes.');
        setInviteDraft('');
      } catch (error) {
        const code = error instanceof ProfileServiceError ? error.code : '';
        setSetupNotice(code === 'invite_unavailable'
          ? 'That invite code is invalid, expired, or already joined.'
          : code === 'invite_rate_limited'
            ? 'Too many code attempts. Try again in 15 minutes.'
          : code === 'profile_required'
            ? 'Save a runner name to the profile service before joining.'
            : 'Couldn’t join the race. Check the connection and try again.');
      } finally {
        setRaceActionBusy(false);
      }
    }

    async function updateStartReadiness(ready: boolean) {
      if (!activeRaceId) return;
      setRaceActionBusy(true);
      setSetupNotice('');
      try {
        const accessToken = await getAccessToken();
        if (!accessToken) throw new ProfileServiceError('No active Privy token.', 'unauthorized', 401);
        await setFriendStartReady(accessToken, activeRaceId, ready);
        setActiveRaceStatus(await getFriendRaceStatus(accessToken, activeRaceId));
      } catch (error) {
        const code = error instanceof ProfileServiceError ? error.code : '';
        setSetupNotice(code === 'race_not_ready_for_start'
          ? 'This race has already moved past start confirmation. Check its current status.'
          : 'Couldn’t update your start confirmation. Check the connection and try again.');
      } finally {
        setRaceActionBusy(false);
      }
    }

    async function updateStrangerReadiness(ready: boolean) {
      if (!strangerRaceId) return;
      setRaceActionBusy(true);
      setSetupNotice('');
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('No active session');
        await setStrangerStartReady(token, strangerRaceId, ready);
        setStrangerRaceStatus(await getStrangerRaceStatus(token, strangerRaceId));
      } catch { setSetupNotice('Couldn’t update start confirmation. Check the connection and retry.'); }
      finally { setRaceActionBusy(false); }
    }

    async function leaveStranger() {
      if (!strangerRaceId) return;
      setRaceActionBusy(true);
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('No active session');
        await leaveStrangerRace(token, strangerRaceId);
        setStrangerRaceId(null);
        setStrangerRaceStatus(null);
        setSetupNotice('You left stranger matching.');
      } catch { setSetupNotice('Couldn’t leave this match. Check the connection and retry.'); }
      finally { setRaceActionBusy(false); }
    }

    const selfStartReady = activeRaceStatus?.participants.find((participant) => participant.isSelf)?.startReady ?? false;
    const friendStartReady = activeRaceStatus?.participants.find((participant) => !participant.isSelf)?.startReady ?? false;
    const serverClockOffset = activeRaceStatus?.serverTime
      ? Date.parse(activeRaceStatus.serverTime) - activeRaceStatus.receivedAt : 0;
    const serverNow = raceClockMs + serverClockOffset;
    const countdownSeconds = activeRaceStatus?.scheduledStartAt
      ? Math.max(0, Math.ceil((Date.parse(activeRaceStatus.scheduledStartAt) - serverNow) / 1000)) : 0;
    const elapsedSeconds = activeRaceStatus?.startedAt
      ? Math.max(0, Math.floor((serverNow - Date.parse(activeRaceStatus.startedAt)) / 1000)) : 0;

    const strangerSelf = strangerRaceStatus?.participants.find((participant) => participant.isSelf);
    const strangerOther = strangerRaceStatus?.participants.find((participant) => !participant.isSelf);
    const strangerClockOffset = strangerRaceStatus?.serverTime
      ? Date.parse(strangerRaceStatus.serverTime) - strangerRaceStatus.receivedAt : 0;
    const strangerNow = raceClockMs + strangerClockOffset;
    const strangerCountdownSeconds = strangerRaceStatus?.scheduledStartAt
      ? Math.max(0, Math.ceil((Date.parse(strangerRaceStatus.scheduledStartAt) - strangerNow) / 1000)) : 0;

    const openedRaceId = openRaceMode === 'strangers' ? strangerRaceId : activeRaceId;
    if (showRoutePicker && openedRaceId) {
      return (
        <RoutePicker
          raceId={openedRaceId}
          mode={openRaceMode}
          getAccessToken={getAccessToken}
          onBack={() => setShowRoutePicker(false)}
        />
      );
    }

    if (showLiveRace && openedRaceId) {
      return <RaceLive raceId={openedRaceId} getAccessToken={getAccessToken} onBack={() => setShowLiveRace(false)}
        onDone={() => {
          // Leaving the results lobby ends this pairing on this phone.
          setShowLiveRace(false);
          if (openRaceMode === 'strangers') {
            setStrangerRaceId(null);
            setStrangerRaceStatus(null);
          } else {
            setActiveRaceId(null);
            setActiveRaceStatus(null);
            setInviteCode(null);
          }
          setSetupNotice('');
        }} />;
    }

    if (showWorldVerificationTest) {
      return <WorldVerificationTest getAccessToken={getAccessToken}
        raceId={verifyingMatchedRace ? strangerRaceId ?? undefined : undefined}
        distanceKm={verifyingMatchedRace ? strangerRaceStatus?.distanceKm : undefined}
        onVerified={() => {
          if (verifyingMatchedRace && strangerRaceId) {
            void (async () => {
              const token = await getAccessToken();
              if (token) setStrangerRaceStatus(await getStrangerRaceStatus(token, strangerRaceId));
            })().catch(() => undefined);
          }
        }}
        onBack={() => { setShowWorldVerificationTest(false); setVerifyingMatchedRace(false); }} />;
    }

    return (
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView ref={homeScrollRef} contentContainerStyle={styles.profileContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <View style={styles.topbar}>
            <Text style={styles.wordmark}>RIVALRY</Text>
            <View style={styles.liveLabel}><View style={styles.liveDot} /><Text style={styles.liveText}>READY TO RACE</Text></View>
          </View>
          <Text style={styles.eyebrow}>WELCOME, @{runnerHandle}</Text>
          <Text accessibilityRole="header" style={styles.profileHeadline}>Who are you racing?</Text>
          <Text style={styles.description}>Pick a race type and distance. You’ll both review your routes before the start.</Text>

          <View style={styles.modeChoices}>
            <Pressable accessibilityRole="button" accessibilityState={{ selected: raceMode === 'friends' }} onPress={() => { modeChosenOnThisLaunch.current = true; setRaceMode('friends'); setSetupNotice(''); }} style={[styles.modeCard, raceMode === 'friends' && styles.modeCardSelected]}>
              <Text style={styles.modeNumber}>01 / WITH A FRIEND</Text>
              <Text style={styles.modeTitle}>Bring your own rival</Text>
              <Text style={styles.modeDescription}>Share an invite link. No World ID check is needed.</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityState={{ selected: raceMode === 'strangers' }} onPress={() => { modeChosenOnThisLaunch.current = true; setRaceMode('strangers'); setSetupNotice(''); }} style={[styles.modeCard, raceMode === 'strangers' && styles.modeCardSelected]}>
              <Text style={styles.modeNumber}>02 / OPEN MATCH</Text>
              <Text style={styles.modeTitle}>Meet at the start line</Text>
              <Text style={styles.modeDescription}>Match with a runner worldwide. Your location stays private.</Text>
            </Pressable>
          </View>

          {(raceMode === 'friends' || !strangerRaceId || strangerRaceStatus?.status === 'completed') ? <View style={styles.distancePanel}>
            <Text style={styles.panelEyebrow}>CHOOSE DISTANCE FOR A NEW RACE</Text>
            <View style={styles.distanceChoices}>
              {([1, 3, 5, 10] as const).map((distance) => (
                <Pressable key={distance} accessibilityRole="button" accessibilityState={{ selected: raceDistance === distance }} onPress={() => setRaceDistance(distance)} style={[styles.distanceOption, raceDistance === distance && styles.distanceOptionSelected]}>
                  <Text style={[styles.distanceNumber, raceDistance === distance && styles.distanceNumberSelected]}>{distance}</Text>
                  <Text style={[styles.distanceLabel, raceDistance === distance && styles.distanceLabelSelected]}>KM</Text>
                </Pressable>
              ))}
            </View>
          </View> : null}
          <View style={styles.raceNote}>
            <Text style={styles.raceNoteTitle}>{raceMode === 'strangers' && raceDistance > 6 ? '10 KM · DEMO ONLY' : raceMode === 'strangers' ? 'VERIFIED STRANGER RACE' : 'A FAIR RACE, WHEREVER YOU ARE'}</Text>
            <Text style={styles.raceNoteText}>
              {raceMode === 'strangers'
                ? raceDistance > 6
                  ? '10 km stranger races require a fresh Selfie Check and an Official ID credential. World ID Sandbox cannot issue the ID credential here yet, so this tier is a demo only and cannot start a verified race.'
                  : 'Before the countdown, both runners complete a fresh Selfie Check. Opponents see race progress, never your live location.'
                : 'Share a private invite link. Both runners review their routes and confirm the start; no World ID verification is required.'}
            </Text>
          </View>
          {raceMode === 'strangers' ? (
            <Pressable accessibilityRole="button" onPress={() => setShowWorldVerificationTest(true)} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonLabel}>Selfie Check for stranger races · Sandbox</Text>
            </Pressable>
          ) : null}
          {(raceMode === 'friends' || !strangerRaceId || strangerRaceStatus?.status === 'completed') ? <Pressable accessibilityRole="button" disabled={raceActionBusy} onPress={() => void startRaceSetup()} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, raceActionBusy && styles.disabled]}>
            {raceActionBusy ? <ActivityIndicator color={colors.white} /> : null}
            {!raceActionBusy ? <Text style={styles.primaryButtonLabel}>{raceMode === 'friends' ? `Create a ${raceDistance} km friend invite` : raceDistance > 6 ? '10 km stranger race · unavailable in Sandbox' : `Find a ${raceDistance} km stranger race`}</Text> : null}
          </Pressable> : null}
          {raceMode === 'friends' && inviteCode && activeRaceStatus?.status === 'waiting_for_opponent' ? (
            <View style={styles.inviteCard}>
              <Text style={styles.raceNoteTitle}>YOUR FRIEND INVITE CODE</Text>
              <Text accessibilityLabel={`Invite code ${inviteCode}`} selectable style={styles.inviteCode}>{inviteCode}</Text>
              <Pressable accessibilityRole="button" onPress={() => void Share.share({ message: `Join my ${activeRaceStatus.distanceKm} km Rivalry race: rivalry:///?invite=${inviteCode}` })} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonLabel}>Share invite link</Text>
              </Pressable>
            </View>
          ) : null}
          {raceMode === 'friends' && activeRaceId && activeRaceStatus ? (
            <View style={styles.inviteCard}>
              <Text style={styles.panelEyebrow}>CURRENT RACE · {activeRaceStatus.distanceKm} KM</Text>
              <Text style={styles.raceNoteTitle}>{activeRaceStatus.status === 'waiting_for_opponent'
                ? 'WAITING FOR YOUR FRIEND'
                : activeRaceStatus.status === 'countdown' ? 'SHARED COUNTDOWN'
                : activeRaceStatus.status === 'active' ? 'RACE STARTED'
                : activeRaceStatus.status === 'completed' ? 'RACE COMPLETE'
                : `PAIRED WITH @${activeRaceStatus.participants.find((participant) => !participant.isSelf)?.handle ?? 'RUNNER'}`}</Text>
              <Text style={styles.raceNoteText}>{activeRaceStatus.status === 'waiting_for_opponent'
                ? 'Your friend can join with the invite code above. Both phones will show the pairing here.'
                : activeRaceStatus.status === 'countdown'
                  ? `Both runners confirmed. Starting together in ${countdownSeconds} seconds.`
                : activeRaceStatus.status === 'active'
                  ? `Started together · ${Math.floor(elapsedSeconds / 60).toString().padStart(2, '0')}:${(elapsedSeconds % 60).toString().padStart(2, '0')} elapsed. Open the live race to record GPS.`
                : activeRaceStatus.status === 'completed'
                  ? 'Both runners are done. Open the race to see the result.'
                : activeRaceStatus.status === 'ready'
                  ? `Both routes are accepted. ${selfStartReady ? friendStartReady ? 'Preparing the countdown.' : 'Waiting for your friend to confirm the start.' : friendStartReady ? 'Your friend is ready. Confirm when you are at your start.' : 'Both runners must confirm they are at their starts.'}`
                  : `Both runners joined this ${activeRaceStatus.distanceKm} km race. Choose a nearby start and review your route.`}</Text>
              {activeRaceStatus.status === 'ready' ? (
                <Pressable accessibilityRole="button" disabled={raceActionBusy} onPress={() => void updateStartReadiness(!selfStartReady)} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, raceActionBusy && styles.disabled]}>
                  {raceActionBusy ? <ActivityIndicator color={colors.white} /> : <Text style={styles.primaryButtonLabel}>{selfStartReady ? 'Cancel my start confirmation' : 'I’m at my start · ready'}</Text>}
                </Pressable>
              ) : null}
              {activeRaceStatus.status === 'route_review' || activeRaceStatus.status === 'ready' ? (
                <Pressable accessibilityRole="button" onPress={() => { setOpenRaceMode('friends'); setShowRoutePicker(true); }} style={styles.secondaryButton}>
                  <Text style={styles.secondaryButtonLabel}>Review my route</Text>
                </Pressable>
              ) : null}
              {activeRaceStatus.status === 'active' || activeRaceStatus.status === 'completed' ? (
                <Pressable accessibilityRole="button" onPress={() => { setOpenRaceMode('friends'); setShowLiveRace(true); }} style={styles.secondaryButton}>
                  <Text style={styles.secondaryButtonLabel}>{activeRaceStatus.status === 'completed' ? 'View result' : 'Open live race'}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {raceMode === 'strangers' && strangerRaceId && strangerRaceStatus ? (
            <View style={styles.inviteCard}>
              <Text style={styles.panelEyebrow}>STRANGER RACE · {strangerRaceStatus.distanceKm} KM</Text>
              <Text style={styles.raceNoteTitle}>{strangerRaceStatus.status === 'waiting_for_opponent'
                ? 'FINDING AN OPPONENT'
                : strangerRaceStatus.status === 'route_review' ? 'MATCHED · REVIEW ROUTES'
                : strangerRaceStatus.status === 'ready' ? 'CONFIRM YOUR START'
                : strangerRaceStatus.status === 'verification' ? 'SELFIE CHECK REQUIRED'
                : strangerRaceStatus.status === 'countdown' ? 'SHARED COUNTDOWN'
                : strangerRaceStatus.status === 'active' ? 'RACE STARTED' : 'RACE COMPLETE'}</Text>
              <Text style={styles.raceNoteText}>{strangerRaceStatus.status === 'waiting_for_opponent'
                ? 'Searching for another runner at this distance. You remain in the queue until matched or you leave.'
                : strangerRaceStatus.status === 'route_review'
                  ? `Matched with @${strangerOther?.handle ?? 'runner'}. Both of you choose a route near your own start.`
                : strangerRaceStatus.status === 'ready'
                  ? strangerSelf?.startReady ? 'Waiting for your opponent to confirm their start.' : 'Both routes are accepted. Confirm when you are at your start.'
                : strangerRaceStatus.status === 'verification'
                  ? strangerRaceStatus.distanceKm === 10
                    ? 'Both runners need a fresh Selfie Check and an Official ID credential. The ID credential is unavailable in this Sandbox setup.'
                    : strangerSelf?.selfieVerified ? 'Your Selfie Check passed. Waiting for your opponent; if they don’t verify within 6 minutes, you return to the queue.' : 'Complete a fresh Selfie Check within 6 minutes, or this match is cancelled.'
                  : strangerRaceStatus.status === 'countdown'
                    ? `Verified Sandbox race starts in ${strangerCountdownSeconds} seconds.`
                    : strangerRaceStatus.status === 'active'
                      ? 'Race in progress. Your opponent sees your progress, never your GPS location.'
                      : 'Open the result to see the outcome.'}</Text>
              {strangerRaceStatus.status === 'route_review' || strangerRaceStatus.status === 'ready' ? (
                <Pressable accessibilityRole="button" onPress={() => { setOpenRaceMode('strangers'); setShowRoutePicker(true); }} style={styles.secondaryButton}>
                  <Text style={styles.secondaryButtonLabel}>Review my route</Text>
                </Pressable>
              ) : null}
              {strangerRaceStatus.status === 'ready' ? (
                <Pressable accessibilityRole="button" disabled={raceActionBusy} onPress={() => void updateStrangerReadiness(!strangerSelf?.startReady)} style={[styles.primaryButton, raceActionBusy && styles.disabled]}>
                  <Text style={styles.primaryButtonLabel}>{strangerSelf?.startReady ? 'Cancel my start confirmation' : 'I’m at my start · ready'}</Text>
                </Pressable>
              ) : null}
              {strangerRaceStatus.status === 'verification' && !strangerSelf?.selfieVerified ? (
                <Pressable accessibilityRole="button" onPress={() => { setVerifyingMatchedRace(true); setShowWorldVerificationTest(true); }} style={styles.primaryButton}>
                  <Text style={styles.primaryButtonLabel}>Complete Selfie Check</Text>
                </Pressable>
              ) : null}
              {strangerRaceStatus.status === 'active' || strangerRaceStatus.status === 'completed' ? (
                <Pressable accessibilityRole="button" onPress={() => { setOpenRaceMode('strangers'); setShowLiveRace(true); }} style={styles.secondaryButton}>
                  <Text style={styles.secondaryButtonLabel}>{strangerRaceStatus.status === 'completed' ? 'View result' : 'Open live race'}</Text>
                </Pressable>
              ) : null}
              {['waiting_for_opponent', 'route_review', 'ready', 'verification', 'countdown'].includes(strangerRaceStatus.status) ? (
                <Pressable accessibilityRole="button" disabled={raceActionBusy} onPress={() => void leaveStranger()} style={styles.textButton}>
                  <Text style={styles.textButtonLabel}>{strangerRaceStatus.status === 'waiting_for_opponent' ? 'Leave queue' : 'Decline this match'}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {raceMode === 'friends' ? (
            <View style={styles.joinPanel}>
              <Text style={styles.panelEyebrow}>JOIN A FRIEND’S RACE</Text>
              <Text style={styles.raceNoteText}>On the second phone, sign in with a different email and runner name, then enter the four-digit code.</Text>
              <TextInput
                accessibilityLabel="Friend race invite code"
                autoCorrect={false}
                keyboardType="number-pad"
                maxLength={4}
                onChangeText={(text) => setInviteDraft(text.replace(/\D/g, '').slice(0, 4))}
                onFocus={() => { inviteInputFocused.current = true; }}
                onBlur={() => { inviteInputFocused.current = false; }}
                placeholder="0000"
                placeholderTextColor={colors.muted}
                style={styles.raceCodeInput}
                value={inviteDraft}
              />
              <Pressable accessibilityRole="button" disabled={raceActionBusy || inviteDraft.length !== 4} onPress={() => void joinInvite()} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, (raceActionBusy || inviteDraft.length !== 4) && styles.disabled]}>
                <Text style={styles.secondaryButtonLabel}>Join with code</Text>
              </Pressable>
            </View>
          ) : null}
          {setupNotice ? <Text accessibilityRole="alert" style={styles.setupNotice}>{setupNotice}</Text> : null}
          <Text style={styles.setupStatus}>{raceMode === 'strangers' ? 'STRANGER RACES · WORLD ID BEFORE START' : 'FRIEND RACES · SHARED START'}</Text>
          <View style={styles.accountActions}>
            <Pressable accessibilityRole="button" onPress={() => { setHandleDraft(runnerHandle); setRunnerHandle(null); }} style={styles.textButton}>
              <Text style={styles.textButtonLabel}>Edit runner name</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => void logout()} style={styles.textButton}>
              <Text style={styles.textButtonLabel}>Sign out</Text>
            </Pressable>
          </View>
        </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.topbar}>
            <Text style={styles.wordmark}>RIVALRY</Text>
            <View style={styles.liveLabel}><View style={styles.liveDot} /><Text style={styles.liveText}>CITY TO CITY</Text></View>
          </View>

          <View style={styles.hero}>
            <Text style={styles.eyebrow}>ONE DISTANCE. TWO CITIES.</Text>
            <Text accessibilityRole="header" style={styles.headline}>Someone, somewhere, is running with you.</Text>
            <Text style={styles.description}>Meet at the same start time. Take on an equally challenging route. See who reaches the finish first.</Text>
          </View>

          <View accessible accessibilityLabel="Two runners starting a race in different cities" style={styles.routePanel}>
            <View style={styles.routeHeader}>
              <Text style={styles.panelEyebrow}>THE SAME RACE</Text>
              <Text style={styles.distance}>05<Text style={styles.distanceUnit}> KM</Text></Text>
            </View>
            <View style={styles.routeLine}>
              <View style={styles.routeStop}><View style={styles.stopMarker} /><Text style={styles.city}>SYDNEY</Text><Text style={styles.localTime}>START · 08:00</Text></View>
              <View style={styles.routeDash} />
              <View style={styles.routeStopRight}><View style={[styles.stopMarker, styles.stopMarkerAlt]} /><Text style={styles.city}>TORONTO</Text><Text style={styles.localTime}>START · 18:00</Text></View>
            </View>
            <View style={styles.routeFooter}><Text style={styles.routeFooterText}>EQUAL DISTANCE</Text><View style={styles.footerDivider} /><Text style={styles.routeFooterText}>SHARED COUNTDOWN</Text></View>
          </View>

          <View style={styles.authPanel}>
            <Text style={styles.authTitle}>{awaitingCode ? 'Check your inbox.' : 'Get in the race.'}</Text>
            <Text style={styles.authDescription}>
              {awaitingCode ? `Enter the sign-in code we sent to ${email.trim()}.` : 'Sign in or create your account with email. No password needed.'}
            </Text>
            {awaitingCode ? (
              <TextInput
                accessibilityLabel="Email sign-in code"
                autoComplete="one-time-code"
                keyboardType="number-pad"
                maxLength={8}
                onChangeText={setCode}
                placeholder="Enter code"
                placeholderTextColor={colors.muted}
                style={styles.input}
                value={code}
              />
            ) : (
              <TextInput
                accessibilityLabel="Email address"
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                onChangeText={setEmail}
                placeholder="you@example.com"
                placeholderTextColor={colors.muted}
                style={styles.input}
                textContentType="emailAddress"
                value={email}
              />
            )}
            {errorMessage ? <Text accessibilityRole="alert" style={styles.error}>{errorMessage}</Text> : null}
            {state.status === 'error' && !errorMessage ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {__DEV__
                  ? `Sign-in request failed: ${(state.error?.message ?? 'Unknown Privy error').replaceAll(email.trim(), '[email]')}`
                  : 'Something went wrong. Please try again.'}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={busy || (awaitingCode ? code.trim().length < 4 : !email.includes('@'))}
              onPress={() => void (awaitingCode ? submitCode() : requestCode())}
              style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, (busy || (awaitingCode ? code.trim().length < 4 : !email.includes('@'))) && styles.disabled]}
            >
              {busy ? <ActivityIndicator color={colors.white} /> : <Text style={styles.primaryButtonLabel}>{awaitingCode ? 'Verify and continue' : 'Send sign-in code'}</Text>}
            </Pressable>
            {awaitingCode ? (
              <View style={styles.codeActions}>
                <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setCode(''); setErrorMessage(''); void requestCode(); }}>
                  <Text style={styles.textButtonLabel}>Send a new code</Text>
                </Pressable>
                <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setCode(''); setErrorMessage(''); setEmail(''); }}>
                  <Text style={styles.textButtonLabel}>Change email</Text>
                </Pressable>
              </View>
            ) : null}
          </View>

          <View style={styles.bottomCopy}>
            <Text style={styles.bottomEyebrow}>FRIENDS OR VERIFIED STRANGERS</Text>
            <Text style={styles.bottomText}>simultaneous remote racing for friends across the world, or for verified strangers</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: colors.paper },
  content: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 14, paddingBottom: 28 },
  profileContent: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 14, paddingBottom: 30 },
  topbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 36 },
  wordmark: { color: colors.ink, fontSize: 15, fontWeight: '900', letterSpacing: 2.4 },
  liveLabel: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.vermilion },
  liveText: { color: colors.muted, fontSize: 10, fontWeight: '700', letterSpacing: 1.4 },
  hero: { paddingBottom: 24 },
  eyebrow: { color: colors.vermilion, fontSize: 11, fontWeight: '800', letterSpacing: 1.7, marginBottom: 13 },
  headline: { color: colors.ink, fontFamily: 'serif', fontSize: 39, lineHeight: 43, letterSpacing: -1.4, maxWidth: 360 },
  description: { color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 13, maxWidth: 340 },
  routePanel: { backgroundColor: colors.paperDeep, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 14 },
  routeHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  panelEyebrow: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, paddingTop: 7 },
  distance: { color: colors.vermilion, fontFamily: 'serif', fontSize: 27, fontWeight: '700', lineHeight: 30 },
  distanceUnit: { color: colors.ink, fontSize: 12, fontWeight: '800', letterSpacing: 1.3 },
  routeLine: { minHeight: 92, flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  routeStop: { alignItems: 'flex-start', width: 105 },
  routeStopRight: { alignItems: 'flex-end', width: 105 },
  stopMarker: { width: 11, height: 11, borderRadius: 6, backgroundColor: colors.vermilion, marginBottom: 9 },
  stopMarkerAlt: { backgroundColor: colors.ink },
  routeDash: { flex: 1, height: 1, backgroundColor: colors.line, marginHorizontal: 7, marginBottom: 34 },
  city: { color: colors.ink, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  localTime: { color: colors.muted, fontSize: 8, fontWeight: '700', letterSpacing: 0.5, marginTop: 5 },
  routeFooter: { borderTopWidth: 1, borderTopColor: colors.line, flexDirection: 'row', alignItems: 'center', paddingTop: 11 },
  routeFooterText: { color: colors.muted, flex: 1, fontSize: 8, fontWeight: '800', letterSpacing: 0.8 },
  footerDivider: { width: 1, height: 12, backgroundColor: colors.line, marginHorizontal: 10 },
  authPanel: { backgroundColor: colors.white, padding: 19, marginTop: 20, borderWidth: 1, borderColor: colors.line },
  authTitle: { color: colors.ink, fontFamily: 'serif', fontSize: 25, lineHeight: 30 },
  authDescription: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 5, marginBottom: 14 },
  input: { height: 52, borderWidth: 1, borderColor: colors.line, color: colors.ink, fontSize: 16, paddingHorizontal: 14, backgroundColor: colors.paper, marginBottom: 11 },
  primaryButton: { minHeight: 52, backgroundColor: colors.vermilion, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  primaryButtonLabel: { color: colors.white, fontSize: 14, fontWeight: '800', letterSpacing: 0.3 },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.45 },
  error: { color: '#A42F20', fontSize: 12, lineHeight: 17, marginBottom: 10 },
  codeActions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 15 },
  textButton: { marginTop: 26 },
  textButtonLabel: { color: colors.vermilion, fontSize: 13, fontWeight: '800' },
  bottomCopy: { marginTop: 'auto', paddingTop: 26 },
  bottomEyebrow: { color: colors.vermilion, fontSize: 10, fontWeight: '800', letterSpacing: 1.3, marginBottom: 7 },
  bottomText: { color: colors.muted, fontSize: 11, lineHeight: 16, maxWidth: 280 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { color: colors.muted, fontSize: 14 },
  signedIn: { flex: 1, paddingHorizontal: 28, paddingTop: 22, justifyContent: 'center', alignItems: 'flex-start' },
  signedInMark: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.vermilion, alignItems: 'center', justifyContent: 'center', marginTop: 70, marginBottom: 25 },
  check: { color: colors.white, fontSize: 27, fontWeight: '700' },
  profileHeadline: { color: colors.ink, fontFamily: 'serif', fontSize: 38, lineHeight: 43, letterSpacing: -1.2 },
  profilePanel: { backgroundColor: colors.white, padding: 19, marginTop: 27, borderWidth: 1, borderColor: colors.line },
  handleInputRow: { height: 56, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.line, backgroundColor: colors.paper, marginTop: 10, paddingHorizontal: 14 },
  handleAt: { color: colors.vermilion, fontSize: 19, fontWeight: '800' },
  handleInput: { flex: 1, color: colors.ink, fontSize: 17, paddingHorizontal: 9 },
  handleHint: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 8, marginBottom: 17 },
  demoNotice: { backgroundColor: colors.paperDeep, padding: 16, marginTop: 19 },
  demoNoticeTitle: { color: colors.vermilion, fontSize: 10, fontWeight: '900', letterSpacing: 1.3, marginBottom: 7 },
  demoNoticeText: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  modeChoices: { gap: 11, marginTop: 24 },
  modeCard: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, padding: 16 },
  modeCardSelected: { borderColor: colors.vermilion, borderWidth: 2, padding: 15 },
  modeNumber: { color: colors.vermilion, fontSize: 9, fontWeight: '900', letterSpacing: 1.25 },
  modeTitle: { color: colors.ink, fontFamily: 'serif', fontSize: 22, marginTop: 7 },
  modeDescription: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 5 },
  distancePanel: { backgroundColor: colors.paperDeep, padding: 16, marginTop: 17 },
  distanceChoices: { flexDirection: 'row', gap: 9, marginTop: 12 },
  distanceOption: { flex: 1, minHeight: 61, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  distanceOptionSelected: { backgroundColor: colors.ink, borderColor: colors.ink },
  distanceNumber: { color: colors.ink, fontSize: 20, fontWeight: '800' },
  distanceNumberSelected: { color: colors.white },
  distanceLabel: { color: colors.muted, fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  distanceLabelSelected: { color: colors.paperDeep },
  raceNote: { padding: 16, borderLeftWidth: 3, borderLeftColor: colors.vermilion, backgroundColor: colors.white, marginTop: 17 },
  raceNoteTitle: { color: colors.vermilion, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  raceNoteText: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 7 },
  setupStatus: { color: colors.muted, textAlign: 'center', fontSize: 8, fontWeight: '800', letterSpacing: 0.9, marginTop: 12 },
  setupNotice: { color: colors.muted, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 10 },
  accountActions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 20 },
  inviteCard: { backgroundColor: colors.white, padding: 16, marginTop: 13, borderWidth: 1, borderColor: colors.line, alignItems: 'center' },
  inviteCode: { color: colors.ink, fontSize: 23, fontWeight: '900', letterSpacing: 2, marginVertical: 12 },
  joinPanel: { backgroundColor: colors.paperDeep, padding: 16, marginTop: 16 },
  raceCodeInput: { height: 50, borderWidth: 1, borderColor: colors.line, color: colors.ink, fontSize: 16, letterSpacing: 1.4, paddingHorizontal: 13, backgroundColor: colors.white, marginTop: 10, marginBottom: 9 },
  secondaryButton: { minHeight: 46, borderWidth: 1, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  secondaryButtonLabel: { color: colors.ink, fontSize: 13, fontWeight: '800' },
});
