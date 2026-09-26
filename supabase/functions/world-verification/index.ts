import { createClient } from '@supabase/supabase-js';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import { signRequest } from '@worldcoin/idkit-core/signing';
import { getPrivyUserId, privyVerificationConfigured } from '../_shared/auth.ts';
import { corsHeaders, jsonResponse } from '../_shared/http.ts';

type CheckKind = 'selfie' | 'official_id';

function getAdminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Server database settings are missing.');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeDiagnostic(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, 200) : null;
}

function worldFailureDetails(response: Response, verification: unknown, result: Record<string, unknown>) {
  const codes = isObject(verification) && Array.isArray(verification.results)
    ? verification.results.flatMap((item: unknown) => isObject(item) && typeof item.code === 'string' ? [item.code] : [])
    : [];
  if (isObject(verification) && typeof verification.code === 'string') codes.unshift(verification.code);

  const bundle = isObject(result.integrity_bundle) ? result.integrity_bundle : null;
  const bundleVersion = bundle && typeof bundle.version === 'number' ? bundle.version : null;
  const bundleAge = bundle && typeof bundle.timestamp === 'number'
    ? Math.round(Date.now() / 1000 - bundle.timestamp)
    : null;
  const detail = isObject(verification)
    ? safeDiagnostic(verification.detail) ?? safeDiagnostic(verification.message)
    : null;
  const bundleSummary = response.status === 403
    ? `integrity bundle v${bundleVersion ?? 'unknown'}, age ${bundleAge ?? 'unknown'}s`
    : null;
  return {
    worldStatus: response.status,
    worldMessage: [detail ?? (!isObject(verification) ? `response type ${response.headers.get('content-type') ?? 'unknown'}` : null), bundleSummary]
      .filter(Boolean).join(' | '),
    worldCodes: codes.slice(0, 5),
  };
}

function validCheckKind(value: unknown): value is CheckKind {
  return value === 'selfie' || value === 'official_id';
}

function config() {
  const appId = Deno.env.get('WORLD_APP_ID');
  const rpId = Deno.env.get('WORLD_RP_ID');
  const signingKeyHex = Deno.env.get('WORLD_SIGNING_KEY');
  const environment = Deno.env.get('WORLD_ID_ENVIRONMENT') ?? 'sandbox';
  if (!appId || !rpId || !signingKeyHex) return null;
  if (!appId.startsWith('app_') || !rpId.startsWith('rp_')) return null;
  if (!['sandbox', 'staging', 'production'].includes(environment)) return null;
  return { appId, rpId, signingKeyHex, environment: environment as 'sandbox' | 'staging' | 'production' };
}

async function startAttempt(
  client: ReturnType<typeof getAdminClient>,
  profileId: string,
  purpose: 'device_test' | 'race',
  checkKind: CheckKind,
  raceId: string | null,
) {
  const world = config();
  if (!world) return jsonResponse({ error: 'world_not_configured' }, 503);

  if (purpose === 'race') {
    if (!raceId || !/^[0-9a-f-]{36}$/i.test(raceId)) return jsonResponse({ error: 'invalid_race_id' }, 400);
    const { data: race, error: raceError } = await client
      .from('races').select('id, mode, distance_km, status').eq('id', raceId).maybeSingle();
    if (raceError) return jsonResponse({ error: 'race_lookup_failed' }, 500);
    // A matched stranger race is the product event that needs trust: before two
    // strangers share a start time and live progress, each proves they are a
    // real, unique person present right now. Selfie Check is the only credential.
    if (!race || race.mode !== 'strangers' || !['route_review', 'ready', 'verification'].includes(race.status)) {
      return jsonResponse({ error: 'race_verification_unavailable' }, 409);
    }
    if (checkKind !== 'selfie') return jsonResponse({ error: 'official_id_not_required' }, 400);
    const { data: participant, error: participantError } = await client
      .from('race_participants').select('state').eq('race_id', raceId).eq('profile_id', profileId).maybeSingle();
    if (participantError) return jsonResponse({ error: 'race_lookup_failed' }, 500);
    if (!participant) return jsonResponse({ error: 'race_not_ready' }, 409);
    const storedKind = checkKind === 'selfie' ? 'selfie' : 'official_id';
    const { data: completed, error: completedError } = await client
      .from('race_verifications').select('verified')
      .eq('race_id', raceId).eq('profile_id', profileId).eq('check_kind', storedKind).maybeSingle();
    if (completedError) return jsonResponse({ error: 'verification_lookup_failed' }, 500);
    if (completed?.verified) return jsonResponse({ error: 'verification_already_complete' }, 409);
  }

  const id = crypto.randomUUID();
  const action = `rivalry-${purpose === 'device_test' ? 'test' : 'race'}-${id.replaceAll('-', '')}`;
  const signal = `rivalry:${purpose}:${id}:${profileId}`;
  const signature = signRequest({ signingKeyHex: world.signingKeyHex, action, ttl: 300 });
  const expiresAt = new Date(signature.expiresAt * 1000).toISOString();
  const { error } = await client.from('world_verification_attempts').insert({
    id,
    race_id: raceId,
    profile_id: profileId,
    purpose,
    check_kind: checkKind,
    action,
    request_nonce: signature.nonce,
    signal_hash: hashSignal(signal),
    environment: world.environment,
    expires_at: expiresAt,
  });
  if (error) return jsonResponse({ error: 'verification_start_failed' }, 500);

  return jsonResponse({
    attemptId: id,
    appId: world.appId,
    action,
    signal,
    environment: world.environment,
    rpContext: {
      rp_id: world.rpId,
      nonce: signature.nonce,
      created_at: signature.createdAt,
      expires_at: signature.expiresAt,
      signature: signature.sig,
    },
  }, 201);
}

async function verifyAttempt(
  client: ReturnType<typeof getAdminClient>,
  profileId: string,
  body: Record<string, unknown>,
) {
  const releaseFailedMatch = async (attempt: { purpose: string; race_id: string | null }) => {
    if (attempt.purpose === 'race' && attempt.race_id) {
      await client.rpc('leave_stranger_race', { p_race_id: attempt.race_id, p_profile_id: profileId });
    }
  };
  const attemptId = body.attemptId;
  if (typeof attemptId !== 'string' || !/^[0-9a-f-]{36}$/i.test(attemptId) || !isObject(body.result)) {
    return jsonResponse({ error: 'invalid_request' }, 400);
  }
  const { data: attempt, error: attemptError } = await client
    .from('world_verification_attempts').select('*').eq('id', attemptId).eq('profile_id', profileId).maybeSingle();
  if (attemptError) return jsonResponse({ error: 'verification_lookup_failed' }, 500);
  if (!attempt || attempt.status !== 'pending') return jsonResponse({ error: 'attempt_unavailable' }, 409);
  if (new Date(attempt.expires_at).getTime() <= Date.now()) {
    await client.from('world_verification_attempts').update({ status: 'expired' }).eq('id', attemptId);
    await releaseFailedMatch(attempt);
    return jsonResponse({ error: 'attempt_expired' }, 410);
  }

  const result = body.result;
  const expectedIdentifier = attempt.check_kind === 'selfie' ? 'selfie' : 'passport';
  const responses = Array.isArray(result.responses) ? result.responses : [];
  const credential = responses.find((item: unknown) => isObject(item) && item.identifier === expectedIdentifier) as Record<string, unknown> | undefined;
  const expectedPresence = attempt.check_kind === 'selfie';
  if (
    result.protocol_version !== '4.0' ||
    result.action !== attempt.action ||
    result.nonce !== attempt.request_nonce ||
    result.environment !== attempt.environment ||
    (expectedPresence && result.user_presence_completed !== true) ||
    !credential ||
    credential.signal_hash !== attempt.signal_hash ||
    (attempt.check_kind === 'selfie' && credential.issuer_schema_id !== 11) ||
    (attempt.check_kind === 'official_id' && credential.issuer_schema_id !== 9303)
  ) {
    await client.from('world_verification_attempts').update({ status: 'failed' }).eq('id', attemptId);
    await releaseFailedMatch(attempt);
    return jsonResponse({ error: 'proof_does_not_match_request' }, 400);
  }

  const world = config();
  if (!world) return jsonResponse({ error: 'world_not_configured' }, 503);
  const worldHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Rivalry/1.0',
  };
  if (world.environment !== 'production') {
    const stagingToken = Deno.env.get('WORLD_STAGING_VERIFICATION_TOKEN');
    if (!stagingToken) return jsonResponse({ error: 'world_staging_not_configured' }, 503);
    worldHeaders['x-staging-verification-token'] = stagingToken;
  }
  let worldResponse: Response;
  try {
    worldResponse = await fetch(`https://developer.world.org/api/v4/verify/${world.rpId}`, {
      method: 'POST',
      headers: worldHeaders,
      body: JSON.stringify(result),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return jsonResponse({ error: 'world_verification_unavailable' }, 502);
  }
  const verification = await worldResponse.json().catch(() => null);
  if (!worldResponse.ok) {
    await client.from('world_verification_attempts').update({ status: 'failed' }).eq('id', attemptId);
    await releaseFailedMatch(attempt);
    return jsonResponse({
      error: 'proof_rejected',
      ...worldFailureDetails(worldResponse, verification, result),
    }, 400);
  }
  const verifiedExpectedCredential = isObject(verification) && Array.isArray(verification.results)
    && verification.results.some((item: unknown) => isObject(item) && item.identifier === expectedIdentifier && item.success === true);
  if (
    !isObject(verification) ||
    verification.success !== true ||
    verification.action !== attempt.action ||
    verification.environment !== attempt.environment ||
    !verifiedExpectedCredential
  ) {
    await client.from('world_verification_attempts').update({ status: 'failed' }).eq('id', attemptId);
    await releaseFailedMatch(attempt);
    return jsonResponse({
      error: 'proof_rejected',
      ...worldFailureDetails(worldResponse, verification, result),
    }, 400);
  }

  const verifiedAt = new Date().toISOString();
  const { error: updateError } = await client.from('world_verification_attempts').update({
    status: 'verified',
    credential_type: expectedIdentifier,
    verified_at: verifiedAt,
  }).eq('id', attemptId).eq('status', 'pending');
  if (updateError) return jsonResponse({ error: 'verification_save_failed' }, 500);

  if (attempt.purpose === 'race' && attempt.race_id) {
    const checkKind = attempt.check_kind === 'selfie' ? 'selfie' : 'official_id';
    const { error: saveRaceVerificationError } = await client.from('race_verifications').upsert({
      race_id: attempt.race_id,
      profile_id: profileId,
      check_kind: checkKind,
      environment: attempt.environment,
      verified: true,
      credential_type: expectedIdentifier,
      checked_at: verifiedAt,
    }, { onConflict: 'race_id,profile_id,check_kind' });
    if (saveRaceVerificationError) return jsonResponse({ error: 'verification_save_failed' }, 500);
    const { data: nextStatus, error: transitionError } = await client.rpc('complete_world_verification', {
      p_race_id: attempt.race_id,
    });
    if (transitionError) return jsonResponse({ error: 'verification_save_failed' }, 500);
    return jsonResponse({
      verified: true,
      checkKind: attempt.check_kind,
      environment: attempt.environment,
      raceStatus: typeof nextStatus === 'string' ? nextStatus : 'verification',
    });
  }

  return jsonResponse({ verified: true, checkKind: attempt.check_kind, environment: attempt.environment });
}

export default {
  async fetch(request: Request) {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
    if (!privyVerificationConfigured()) return jsonResponse({ error: 'server_not_configured' }, 503);
    const privyUserId = await getPrivyUserId(request);
    if (!privyUserId) return jsonResponse({ error: 'unauthorized' }, 401);

    const world = config();
    if (!world) return jsonResponse({ error: 'world_not_configured' }, 503);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'invalid_request' }, 400);
    }
    if (!isObject(body)) return jsonResponse({ error: 'invalid_request' }, 400);
    let client: ReturnType<typeof getAdminClient>;
    try {
      client = getAdminClient();
    } catch {
      return jsonResponse({ error: 'server_not_configured' }, 503);
    }
    const { data: profile, error: profileError } = await client
      .from('profiles').select('id').eq('privy_user_id', privyUserId).maybeSingle();
    if (profileError) return jsonResponse({ error: 'profile_lookup_failed' }, 500);
    if (!profile) return jsonResponse({ error: 'profile_required' }, 409);

    if (body.action === 'start_test' || body.action === 'start_race') {
      if (!validCheckKind(body.checkKind)) return jsonResponse({ error: 'invalid_check_kind' }, 400);
      const purpose = body.action === 'start_test' ? 'device_test' : 'race';
      const raceId = typeof body.raceId === 'string' ? body.raceId : null;
      return await startAttempt(client, profile.id, purpose, body.checkKind, raceId);
    }
    if (body.action === 'verify') return await verifyAttempt(client, profile.id, body);
    return jsonResponse({ error: 'invalid_action' }, 400);
  },
};
