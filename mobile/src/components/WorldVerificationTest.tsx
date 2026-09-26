import { useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import { createURL } from 'expo-linking';
import { ProfileServiceError } from '@/lib/profileService';
import { startWorldRaceVerification, startWorldVerificationTest, submitWorldVerificationResult } from '@/lib/worldVerificationService';

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
      const request = await IDKit.request({
        app_id: command.appId,
        action: command.action,
        action_description: command.actionDescription,
        rp_context: command.rpContext,
        allow_legacy_proofs: false,
        environment: command.environment,
        return_to: command.returnTo,
        require_user_presence: true,
      }).preset(IDKit.selfieCheck({ signal: command.signal }));
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

type Props = {
  getAccessToken: () => Promise<string | null>;
  /** Present for a matched stranger race; absent for the Sandbox preview. */
  raceId?: string;
  onVerified?: () => void;
  /** Standalone preview screen only. */
  onBack?: () => void;
  /** Rendered as a step inside the race screen. */
  embedded?: boolean;
};

export default function WorldVerificationTest({ getAccessToken, onBack, raceId, onVerified, embedded = false }: Props) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [webViewKey, setWebViewKey] = useState(0);
  const webView = useRef<WebView | null>(null);
  const runtimeReady = useRef(false);
  const pendingAttemptId = useRef<string | null>(null);

  async function runCheck() {
    if (!runtimeReady.current) {
      setError('World ID is still loading. Wait a moment, then retry.');
      return;
    }
    setBusy(true);
    setNotice('Preparing a one-time Selfie Check request…');
    setError('');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Please sign in again, then retry.');
      const config = raceId
        ? await startWorldRaceVerification(token, raceId, 'selfie')
        : await startWorldVerificationTest(token, 'selfie');
      pendingAttemptId.current = config.attemptId;
      webView.current?.postMessage(JSON.stringify({
        type: 'start',
        appId: config.appId,
        action: config.action,
        actionDescription: raceId ? 'Confirm you are a real person for this Rivalry race' : 'Try the Rivalry Selfie Check',
        rpContext: config.rpContext,
        signal: config.signal,
        environment: config.environment,
        returnTo: createURL(''),
      }));
    } catch (caught) {
      const code = caught instanceof ProfileServiceError ? caught.code : '';
      setError(code === 'world_not_configured'
        ? 'World is not configured on the server yet. Add the Portal values to Supabase Function Secrets.'
        : code === 'race_verification_unavailable'
          ? 'This match is no longer waiting for verification.'
          : caught instanceof Error ? caught.message : 'World verification failed. Please try again.');
      setNotice('');
      pendingAttemptId.current = null;
      setBusy(false);
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
      setNotice('World ID is opening. Take your selfie there, then come back to Rivalry.');
      try {
        await Linking.openURL(message.url);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not open World ID.');
        setNotice('');
        setBusy(false);
      }
      return;
    }
    if (message.type === 'error') {
      setError(message.message || 'World verification failed. Please try again.');
      setNotice('');
      setBusy(false);
      pendingAttemptId.current = null;
      return;
    }
    if (message.type === 'result' && message.result !== undefined) {
      const attemptId = pendingAttemptId.current;
      if (!attemptId) return;
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Your sign-in expired before the result could be saved.');
        await submitWorldVerificationResult(token, attemptId, message.result);
        setNotice(raceId ? 'Selfie Check passed for this race.' : 'Sandbox Selfie Check passed, including the fresh presence check.');
        setError('');
        onVerified?.();
      } catch (caught) {
        const code = caught instanceof ProfileServiceError ? caught.code : '';
        setError(code === 'world_not_configured'
          ? 'World is not configured on the server yet. Check the Portal values in Supabase Function Secrets.'
          : caught instanceof Error ? caught.message : 'World verification failed. Please try again.');
        setNotice('');
      } finally {
        setBusy(false);
        pendingAttemptId.current = null;
      }
    }
  }

  const panel = (
    <>
      <View style={[styles.card, embedded && styles.cardEmbedded]}>
        <Text style={styles.cardTitle}>WHY A SELFIE CHECK?</Text>
        <Text style={styles.cardText}>You’re about to share a start time and live race progress with a stranger. A fresh World ID Selfie Check proves each runner is a real, unique person who is present right now, without revealing who they are. It’s the lightest check that answers that question.</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void runCheck()} style={[styles.button, busy && styles.disabled]}>
          {busy ? <ActivityIndicator color={colors.white} /> : <Text style={styles.buttonText}>{raceId ? 'Verify with Selfie Check' : 'Try Selfie Check'}</Text>}
        </Pressable>
      </View>
      {notice ? <Text accessibilityLiveRegion="polite" style={styles.status}>{notice}</Text> : null}
      {error ? <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text> : null}
      <WebView
        key={webViewKey}
        ref={webView}
        source={{ html: IDKIT_RUNTIME_HTML, baseUrl: 'https://rivalry.invalid' }}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={['*']}
        onMessage={handleRuntimeMessage}
        onError={(event) => {
          setError(event.nativeEvent.description || 'Could not load the World ID runtime.');
          setBusy(false);
        }}
        onContentProcessDidTerminate={() => {
          // iOS can reclaim the hidden WebView while World ID uses the camera.
          runtimeReady.current = false;
          pendingAttemptId.current = null;
          setBusy(false);
          setNotice('');
          setError('Rivalry lost the World ID connection while you were away. Tap verify to start a new Selfie Check.');
          setWebViewKey((value) => value + 1);
        }}
        style={styles.runtime}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
    </>
  );

  if (embedded) return <View>{panel}</View>;
  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" onPress={onBack} style={styles.back}><Text style={styles.backText}>‹  BACK</Text></Pressable>
        <Text style={styles.eyebrow}>WORLD ID · SANDBOX PREVIEW</Text>
        <Text accessibilityRole="header" style={styles.title}>Stranger race verification.</Text>
        <Text style={styles.description}>Every stranger race starts with a fresh Selfie Check, right after you’re matched. This preview lets you try it; its result does not verify a race.</Text>
        {panel}
      </ScrollView>
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
  card: { backgroundColor: colors.white, borderColor: colors.line, borderWidth: 1, padding: 18, marginBottom: 14 },
  cardEmbedded: { borderWidth: 0, padding: 0, backgroundColor: 'transparent' },
  cardTitle: { color: colors.ink, fontSize: 11, fontWeight: '800', letterSpacing: 1.3, marginBottom: 8 },
  cardText: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: 16 },
  button: { minHeight: 50, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.ink, paddingHorizontal: 16 },
  disabled: { opacity: 0.55 },
  buttonText: { color: colors.white, fontWeight: '800', fontSize: 14 },
  status: { color: colors.ink, fontSize: 13, lineHeight: 19, marginTop: 10 },
  error: { color: colors.red, fontSize: 13, lineHeight: 19, marginTop: 10 },
  runtime: { position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0 },
});
