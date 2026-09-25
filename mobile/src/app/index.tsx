import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
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
import { getRunnerHandle, saveRunnerHandle } from '@/lib/runnerProfile';
import { getRemoteRunnerHandle, isProfileServiceConfigured, ProfileServiceError, reserveRemoteRunnerHandle } from '@/lib/profileService';
import { createFriendInvite, joinFriendInvite } from '@/lib/raceService';

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
  const privyUserId = user?.id;
  const awaitingCode = state.status === 'awaiting-code-input' || state.status === 'submitting-code';
  const busy = state.status === 'sending-code' || state.status === 'submitting-code';

  useEffect(() => {
    if (!privyUserId) return;

    let cancelled = false;
    const loadHandle = async () => {
      if (isProfileServiceConfigured()) {
        const accessToken = await getAccessToken();
        if (!accessToken) throw new Error('No active Privy access token.');
        const remoteHandle = await getRemoteRunnerHandle(accessToken);
        if (remoteHandle) await saveRunnerHandle(privyUserId, remoteHandle);
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
          await saveRunnerHandle(profileUserId, savedHandle);
          setRunnerHandle(savedHandle);
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
        setSetupNotice('Stranger matching and World verification are the next server flow. No queue entry has been created yet.');
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
        setInviteCode(invite.inviteCode);
        setSetupNotice('Invite created. Share this code with one friend; it expires in 48 hours.');
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
        setRaceDistance(joined.distanceKm);
        setSetupNotice('You joined the friend race. Next, both runners choose safe starts and review their routes.');
        setInviteDraft('');
      } catch (error) {
        const code = error instanceof ProfileServiceError ? error.code : '';
        setSetupNotice(code === 'invite_unavailable'
          ? 'That invite code is invalid, expired, or already joined.'
          : code === 'profile_required'
            ? 'Save a runner name to the profile service before joining.'
            : 'Couldn’t join the race. Check the connection and try again.');
      } finally {
        setRaceActionBusy(false);
      }
    }

    return (
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.profileContent}>
          <View style={styles.topbar}>
            <Text style={styles.wordmark}>RIVALRY</Text>
            <View style={styles.liveLabel}><View style={styles.liveDot} /><Text style={styles.liveText}>READY TO RACE</Text></View>
          </View>
          <Text style={styles.eyebrow}>WELCOME, @{runnerHandle}</Text>
          <Text accessibilityRole="header" style={styles.profileHeadline}>Who are you racing?</Text>
          <Text style={styles.description}>Pick a race type and distance. You’ll both review your routes before the start.</Text>

          <View style={styles.modeChoices}>
            <Pressable accessibilityRole="button" accessibilityState={{ selected: raceMode === 'friends' }} onPress={() => { setRaceMode('friends'); setSetupNotice(''); }} style={[styles.modeCard, raceMode === 'friends' && styles.modeCardSelected]}>
              <Text style={styles.modeNumber}>01 / WITH A FRIEND</Text>
              <Text style={styles.modeTitle}>Bring your own rival</Text>
              <Text style={styles.modeDescription}>Invite someone you know. See each other’s live map during the race.</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityState={{ selected: raceMode === 'strangers' }} onPress={() => { setRaceMode('strangers'); setSetupNotice(''); }} style={[styles.modeCard, raceMode === 'strangers' && styles.modeCardSelected]}>
              <Text style={styles.modeNumber}>02 / OPEN MATCH</Text>
              <Text style={styles.modeTitle}>Meet at the start line</Text>
              <Text style={styles.modeDescription}>Match with a runner worldwide. Your location stays private.</Text>
            </Pressable>
          </View>

          <View style={styles.distancePanel}>
            <Text style={styles.panelEyebrow}>CHOOSE YOUR DISTANCE</Text>
            <View style={styles.distanceChoices}>
              {([1, 3, 5, 10] as const).map((distance) => (
                <Pressable key={distance} accessibilityRole="button" accessibilityState={{ selected: raceDistance === distance }} onPress={() => setRaceDistance(distance)} style={[styles.distanceOption, raceDistance === distance && styles.distanceOptionSelected]}>
                  <Text style={[styles.distanceNumber, raceDistance === distance && styles.distanceNumberSelected]}>{distance}</Text>
                  <Text style={[styles.distanceLabel, raceDistance === distance && styles.distanceLabelSelected]}>KM</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={styles.raceNote}>
            <Text style={styles.raceNoteTitle}>{raceMode === 'strangers' && raceDistance > 6 ? 'VERIFICATION FOR THIS RACE' : raceMode === 'strangers' ? 'VERIFIED STRANGER RACE' : 'A FAIR RACE, WHEREVER YOU ARE'}</Text>
            <Text style={styles.raceNoteText}>
              {raceMode === 'strangers'
                ? raceDistance > 6
                  ? 'Before the countdown, both runners complete a fresh Selfie Check and prove possession of a supported Official ID credential. The demo can label its ID step as simulated.'
                  : 'Before the countdown, both runners complete a fresh Selfie Check. Opponents see race progress, never your live location.'
                : 'Choose the same distance together. Rivalry will compare route elevation and show any difference for both runners to accept.'}
            </Text>
          </View>
          <Pressable accessibilityRole="button" disabled={raceActionBusy} onPress={() => void startRaceSetup()} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, raceActionBusy && styles.disabled]}>
            {raceActionBusy ? <ActivityIndicator color={colors.white} /> : null}
            {!raceActionBusy ? <Text style={styles.primaryButtonLabel}>{raceMode === 'friends' ? `Create a ${raceDistance} km friend invite` : `Find a ${raceDistance} km stranger race`}</Text> : null}
          </Pressable>
          {raceMode === 'friends' && inviteCode ? (
            <View style={styles.inviteCard}>
              <Text style={styles.raceNoteTitle}>YOUR FRIEND INVITE CODE</Text>
              <Text accessibilityLabel={`Invite code ${inviteCode}`} selectable style={styles.inviteCode}>{inviteCode}</Text>
              <Pressable accessibilityRole="button" onPress={() => void Share.share({ message: `Join my ${raceDistance} km Rivalry race. Enter invite code ${inviteCode} in the app.` })} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonLabel}>Share invite</Text>
              </Pressable>
            </View>
          ) : null}
          {raceMode === 'friends' ? (
            <View style={styles.joinPanel}>
              <Text style={styles.panelEyebrow}>JOIN A FRIEND’S RACE</Text>
              <TextInput
                accessibilityLabel="Friend race invite code"
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={19}
                onChangeText={setInviteDraft}
                placeholder="xxxx-xxxx-xxxx"
                placeholderTextColor={colors.muted}
                style={styles.raceCodeInput}
                value={inviteDraft}
              />
              <Pressable accessibilityRole="button" disabled={raceActionBusy || inviteDraft.replace(/[^a-z2-7]/gi, '').length !== 16} onPress={() => void joinInvite()} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, (raceActionBusy || inviteDraft.replace(/[^a-z2-7]/gi, '').length !== 16) && styles.disabled]}>
                <Text style={styles.secondaryButtonLabel}>Join with code</Text>
              </Pressable>
            </View>
          ) : null}
          {setupNotice ? <Text accessibilityRole="alert" style={styles.setupNotice}>{setupNotice}</Text> : null}
          <Text style={styles.setupStatus}>RACE SETUP PREVIEW · INVITES, MATCHING, AND ROUTES ARE NEXT</Text>
          <View style={styles.accountActions}>
            <Pressable accessibilityRole="button" onPress={() => { setHandleDraft(runnerHandle); setRunnerHandle(null); }} style={styles.textButton}>
              <Text style={styles.textButtonLabel}>Edit runner name</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => void logout()} style={styles.textButton}>
              <Text style={styles.textButtonLabel}>Sign out</Text>
            </Pressable>
          </View>
        </ScrollView>
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
