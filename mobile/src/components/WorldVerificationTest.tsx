import { useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import { createURL } from 'expo-linking';
import { ProfileServiceError } from '@/lib/profileService';
import { startWorldRaceVerification, startWorldVerificationTest, submitWorldVerificationResult, type WorldCheckKind } from '@/lib/worldVerificationService';

const colors = { paper: '#F4F0E8', ink: '#292722', muted: '#706B63', red: '#E24B35', line: '#C9C0B3', white: '#FFFEFC' };
const IDKIT_RUNTIME_HTML = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><script>
  function send(message) { window.ReactNativeWebView.postMessage(JSON.stringify(message)); }
  window.addEventListener('message', event => handleCommand(event.data));
  document.addEventListener('message', event => handleCommand(event.data));
  async function handleCommand(raw) {
    let command;
    try { command = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
    if (command.type !== 'start') return;
    try {
      const check = command.checkKind === 'selfie'
        ? IDKit.selfieCheck({ signal: command.signal })
        : IDKit.passport({ signal: command.signal });
      const request = await IDKit.request({
        app_id: command.appId,
        action: command.action,
        action_description: command.actionDescription,
        rp_context: command.rpContext,
        allow_legacy_proofs: false,
        environment: command.environment,
        return_to: command.returnTo,
        ...(command.checkKind === 'selfie' ? { require_user_presence: true } : {}),
      }).preset(check);
      send({ type: 'connector', url: request.connectorURI });
      const completion = await request.pollUntilCompletion({ pollInterval: 2000, timeout: 180000 });
      if (!completion.success) throw new Error('The check did not complete (' + String(completion.error) + ').');
      send({ type: 'result', result: completion.result });
    } catch (error) {
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }
</script>
<script src="https://cdn.jsdelivr.net/npm/@worldcoin/idkit-core@4.3.0/dist/idkit.global.js"
  onload="send({ type: 'ready' })"
  onerror="send({ type: 'error', message: 'Could not load the IDKit WebAssembly runtime. Check the phone connection and retry.' })"></script>
</body></html>`;

type Props = { getAccessToken: () => Promise<string | null>; onBack: () => void; raceId?: string; distanceKm?: number; onVerified?: () => void };

export default function WorldVerificationTest({ getAccessToken, onBack, raceId, distanceKm, onVerified }: Props) {
  const [busy, setBusy] = useState<WorldCheckKind | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const webView = useRef<WebView | null>(null);
  const runtimeReady = useRef(false);
  const pendingAttempt = useRef<{ attemptId: string; checkKind: WorldCheckKind } | null>(null);

  async function runCheck(checkKind: WorldCheckKind) {
    if (!runtimeReady.current) {
      setError('IDKit is still loading. Wait a moment, then retry.');
      return;
    }
    setBusy(checkKind);
    setNotice('Preparing a one-time Sandbox request…');
    setError('');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Please sign in again, then retry.');
      const config = raceId
        ? await startWorldRaceVerification(token, raceId, checkKind)
        : await startWorldVerificationTest(token, checkKind);
      pendingAttempt.current = { attemptId: config.attemptId, checkKind };
      webView.current?.postMessage(JSON.stringify({
        type: 'start',
        appId: config.appId,
        action: config.action,
        actionDescription: checkKind === 'selfie'
          ? raceId ? 'Verify this Rivalry stranger race' : 'Test Rivalry Selfie Check'
          : raceId ? 'Verify the 10 km Rivalry race credential' : 'Test Rivalry passport credential',
        rpContext: config.rpContext,
        signal: config.signal,
        environment: config.environment,
        returnTo: createURL(''),
        checkKind,
      }));
    } catch (caught) {
      const code = caught instanceof ProfileServiceError ? caught.code : '';
      setError(code === 'world_not_configured'
        ? 'World is not configured on the server yet. Add the Portal values to Supabase Function Secrets.'
        : caught instanceof Error ? caught.message : 'World verification failed. Please try again.');
      setNotice('');
      pendingAttempt.current = null;
      setBusy(null);
    }
  }

  async function handleRuntimeMessage(event: WebViewMessageEvent) {
    let message: { type?: string; url?: string; message?: string; result?: unknown };
    try { message = JSON.parse(event.nativeEvent.data); } catch { return; }
    if (message.type === 'ready') {
      runtimeReady.current = true;
      return;
    }
    if (message.type === 'connector' && message.url) {
      setNotice('World ID Sandbox is opening. Complete the check, then return to Rivalry.');
      try {
        await Linking.openURL(message.url);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not open the World ID Sandbox app.');
        setNotice('');
        setBusy(null);
      }
      return;
    }
    if (message.type === 'error') {
      setError(message.message || 'World verification failed. Please try again.');
      setNotice('');
      setBusy(null);
      pendingAttempt.current = null;
      return;
    }
    if (message.type === 'result' && message.result !== undefined) {
      const attempt = pendingAttempt.current;
      if (!attempt) return;
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Your sign-in expired before the result could be saved.');
        await submitWorldVerificationResult(token, attempt.attemptId, message.result);
        setNotice(attempt.checkKind === 'selfie'
          ? raceId ? 'Selfie Check passed for this stranger race.' : 'Sandbox Selfie Check passed, including the fresh presence check.'
          : raceId ? 'Official ID credential passed for this race.' : 'Sandbox passport credential passed.');
        setError('');
        onVerified?.();
      } catch (caught) {
        const code = caught instanceof ProfileServiceError ? caught.code : '';
        setError(code === 'world_not_configured'
          ? 'World is not configured on the server yet. Check the Portal values in Supabase Function Secrets.'
          : caught instanceof Error ? caught.message : 'World verification failed. Please try again.');
        setNotice('');
      } finally {
        setBusy(null);
        pendingAttempt.current = null;
      }
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" onPress={onBack} style={styles.back}><Text style={styles.backText}>‹  BACK</Text></Pressable>
        <Text style={styles.eyebrow}>WORLD ID · {raceId ? 'STRANGER RACE' : 'SANDBOX PREVIEW'}</Text>
        <Text accessibilityRole="header" style={styles.title}>{raceId ? 'Verify this race.' : 'Stranger race verification.'}</Text>
        <Text style={styles.description}>{raceId
          ? 'Complete a fresh Selfie Check for this matched race. Sandbox proofs are simulated and count only toward this Sandbox race.'
          : 'Stranger races require a fresh Selfie Check before the countdown. This Sandbox screen previews that check; its result does not verify a race.'}</Text>
        <View style={styles.noticeCard}>
          <Text style={styles.cardTitle}>SELFIE CHECK · EVERY STRANGER RACE</Text>
          <Text style={styles.cardText}>Complete a fresh World presence check on this phone.</Text>
          <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => void runCheck('selfie')} style={[styles.button, busy !== null && styles.disabled]}>
            {busy === 'selfie' ? <ActivityIndicator color={colors.white} /> : <Text style={styles.buttonText}>{raceId ? 'Verify with Selfie Check' : 'Test Selfie Check'}</Text>}
          </Pressable>
        </View>
        {(!raceId || distanceKm === 10) ? <View style={styles.noticeCard}>
          <Text style={styles.cardTitle}>10 KM · ID CREDENTIAL DEMO ONLY</Text>
          <Text style={styles.cardText}>World ID Sandbox cannot issue a passport or national ID credential on this phone yet. This step is a demo of the requirement; no ID proof has been verified. A real 10 km stranger race must wait for a supported World ID credential.</Text>
        </View> : null}
        {notice ? <Text accessibilityLiveRegion="polite" style={styles.status}>{notice}</Text> : null}
        {error ? <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text> : null}
      </ScrollView>
      <WebView
        ref={webView}
        source={{ html: IDKIT_RUNTIME_HTML, baseUrl: 'https://rivalry.invalid' }}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={['*']}
        onMessage={handleRuntimeMessage}
        onError={(event) => {
          setError(event.nativeEvent.description || 'Could not load the IDKit runtime.');
          setBusy(null);
        }}
        style={styles.runtime}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.paper },
  content: { flexGrow: 1, padding: 24, paddingTop: 18 },
  back: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', marginBottom: 22 },
  backText: { color: colors.ink, fontSize: 12, fontWeight: '800', letterSpacing: 1.5 },
  eyebrow: { color: colors.red, fontSize: 11, fontWeight: '800', letterSpacing: 2, marginBottom: 12 },
  title: { color: colors.ink, fontFamily: 'serif', fontSize: 36, lineHeight: 42, marginBottom: 12 },
  description: { color: colors.muted, fontSize: 15, lineHeight: 23, marginBottom: 24 },
  noticeCard: { backgroundColor: colors.white, borderColor: colors.line, borderWidth: 1, borderRadius: 16, padding: 18, marginBottom: 14 },
  cardTitle: { color: colors.ink, fontSize: 11, fontWeight: '800', letterSpacing: 1.3, marginBottom: 8 },
  cardText: { color: colors.muted, fontSize: 14, lineHeight: 20, marginBottom: 16 },
  button: { minHeight: 50, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.ink, borderRadius: 12, paddingHorizontal: 16 },
  disabled: { opacity: 0.55 },
  buttonText: { color: colors.white, fontWeight: '800', fontSize: 14 },
  status: { color: colors.ink, fontSize: 14, lineHeight: 20, marginTop: 10 },
  error: { color: colors.red, fontSize: 14, lineHeight: 20, marginTop: 10 },
  runtime: { position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0 },
});
