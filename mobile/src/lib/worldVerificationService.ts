import { ProfileServiceError } from '@/lib/profileService';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export type WorldCheckKind = 'selfie' | 'official_id';

export type WorldVerificationRequest = {
  attemptId: string;
  appId: `app_${string}`;
  action: string;
  signal: string;
  environment: 'sandbox' | 'staging' | 'production';
  rpContext: {
    rp_id: `rp_${string}`;
    nonce: string;
    created_at: number;
    expires_at: number;
    signature: string;
  };
};

async function requestWorldVerification(accessToken: string, payload: Record<string, unknown>) {
  if (!supabaseUrl || !publishableKey) {
    throw new ProfileServiceError('World verification is not configured.', 'not_configured', 503);
  }
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/world-verification`, {
      method: 'POST',
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new ProfileServiceError('Could not reach World verification.', 'network_error', 0);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await response.json();
  } catch {
    // Status below still provides a useful error.
  }
  if (!response.ok) {
    const code = typeof body.error === 'string' ? body.error : 'request_failed';
    const worldStatus = typeof body.worldStatus === 'number' ? body.worldStatus : null;
    const worldCodes = Array.isArray(body.worldCodes)
      ? body.worldCodes.filter((value): value is string => typeof value === 'string').slice(0, 5)
      : [];
    const worldMessage = typeof body.worldMessage === 'string' ? body.worldMessage : null;
    const diagnostic = [
      worldStatus === null ? null : `World HTTP ${worldStatus}`,
      ...worldCodes,
      worldMessage,
    ].filter(Boolean).join(': ');
    const message = payload.action === 'verify'
      ? `World verification was not accepted (${code})${diagnostic ? ` — ${diagnostic}` : ''}.`
      : `Could not start World verification (${code}).`;
    throw new ProfileServiceError(message, code, response.status);
  }
  return body;
}

async function startWorldVerification(accessToken: string, checkKind: WorldCheckKind, raceId?: string): Promise<WorldVerificationRequest> {
  const result = await requestWorldVerification(accessToken,
    raceId ? { action: 'start_race', checkKind, raceId } : { action: 'start_test', checkKind });
  const rpContext = result.rpContext as WorldVerificationRequest['rpContext'] | undefined;
  if (
    typeof result.attemptId !== 'string' ||
    typeof result.appId !== 'string' || !result.appId.startsWith('app_') ||
    typeof result.action !== 'string' ||
    typeof result.signal !== 'string' ||
    !['sandbox', 'staging', 'production'].includes(String(result.environment)) ||
    !rpContext || typeof rpContext.rp_id !== 'string' || !rpContext.rp_id.startsWith('rp_') ||
    typeof rpContext.nonce !== 'string' || typeof rpContext.signature !== 'string' ||
    typeof rpContext.created_at !== 'number' || typeof rpContext.expires_at !== 'number'
  ) {
    throw new ProfileServiceError('World returned an invalid verification request.', 'invalid_response', 502);
  }
  return {
    attemptId: result.attemptId,
    appId: result.appId as `app_${string}`,
    action: result.action,
    signal: result.signal,
    environment: result.environment as WorldVerificationRequest['environment'],
    rpContext,
  };
}

export const startWorldVerificationTest = (accessToken: string, checkKind: WorldCheckKind) =>
  startWorldVerification(accessToken, checkKind);

export const startWorldRaceVerification = (accessToken: string, raceId: string, checkKind: WorldCheckKind) =>
  startWorldVerification(accessToken, checkKind, raceId);

export async function submitWorldVerificationResult(accessToken: string, attemptId: string, result: unknown) {
  const response = await requestWorldVerification(accessToken, { action: 'verify', attemptId, result });
  if (response.verified !== true) {
    throw new ProfileServiceError('World did not confirm the proof.', 'proof_rejected', 400);
  }
  return {
    checkKind: response.checkKind === 'selfie' ? 'selfie' as const : 'official_id' as const,
    environment: String(response.environment),
  };
}
