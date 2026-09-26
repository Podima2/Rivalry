import { createClient } from '@supabase/supabase-js';
import { getPrivyUserId, privyVerificationConfigured } from '../_shared/auth.ts';
import { corsHeaders, jsonResponse } from '../_shared/http.ts';

function adminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Server database settings are missing.');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export default {
  async fetch(request: Request) {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
    if (!privyVerificationConfigured()) return jsonResponse({ error: 'server_not_configured' }, 503);
    const userId = await getPrivyUserId(request);
    if (!userId) return jsonResponse({ error: 'unauthorized' }, 401);
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
      body = parsed as Record<string, unknown>;
    } catch { return jsonResponse({ error: 'invalid_request' }, 400); }
    if (!['queue', 'active', 'status', 'accept_route', 'start_ready', 'leave'].includes(String(body.action))) {
      return jsonResponse({ error: 'invalid_action' }, 400);
    }
    let client: ReturnType<typeof adminClient>;
    try { client = adminClient(); } catch { return jsonResponse({ error: 'server_not_configured' }, 503); }
    const { data: profile, error: profileError } = await client.from('profiles')
      .select('id').eq('privy_user_id', userId).maybeSingle();
    if (profileError) return jsonResponse({ error: 'profile_lookup_failed' }, 500);
    if (!profile) return jsonResponse({ error: 'profile_required' }, 409);

    if (body.action === 'queue') {
      const distanceKm = Number(body.distanceKm);
      if (![1, 3, 5, 10].includes(distanceKm)) return jsonResponse({ error: 'invalid_distance' }, 400);
      await client.rpc('dismiss_completed_races', { p_profile_id: profile.id });
      const { data: raceId, error } = await client.rpc('join_stranger_queue', {
        p_profile_id: profile.id, p_distance_km: distanceKm,
      });
      if (error || typeof raceId !== 'string') return jsonResponse({ error: 'queue_failed' }, 500);
      return jsonResponse({ raceId });
    }

    if (body.action === 'active') {
      const { data: memberships, error } = await client.from('race_participants')
        .select('race_id, result_dismissed_at').eq('profile_id', profile.id).order('created_at', { ascending: false }).limit(30);
      if (error) return jsonResponse({ error: 'race_lookup_failed' }, 500);
      const ids = (memberships ?? []).map((item) => item.race_id);
      if (!ids.length) return jsonResponse({ raceId: null });
      const { data: races, error: raceError } = await client.from('races')
        .select('id, distance_km, status, completed_at').in('id', ids).eq('mode', 'strangers')
        .in('status', ['waiting_for_opponent', 'route_review', 'ready', 'verification', 'countdown', 'active', 'completed'])
        .order('created_at', { ascending: false });
      if (raceError) return jsonResponse({ error: 'race_lookup_failed' }, 500);
      // A finished race stays in its results lobby until this runner leaves it.
      const dismissed = new Set((memberships ?? []).filter((item) => item.result_dismissed_at).map((item) => item.race_id));
      const race = (races ?? []).find((item) => item.status !== 'completed' ||
        (!dismissed.has(item.id) && Date.parse(item.completed_at) > Date.now() - 24 * 60 * 60 * 1000));
      return jsonResponse(race ? { raceId: race.id, distanceKm: race.distance_km } : { raceId: null });
    }

    if (typeof body.raceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.raceId)) {
      return jsonResponse({ error: 'invalid_race_id' }, 400);
    }
    const { data: race, error: raceError } = await client.from('races')
      .select('id, mode, status, distance_km, scheduled_start_at, started_at')
      .eq('id', body.raceId).maybeSingle();
    if (raceError) return jsonResponse({ error: 'race_lookup_failed' }, 500);
    if (!race || race.mode !== 'strangers') return jsonResponse({ error: 'race_unavailable' }, 404);
    const { data: membership, error: membershipError } = await client.from('race_participants')
      .select('profile_id').eq('race_id', race.id).eq('profile_id', profile.id).maybeSingle();
    if (membershipError) return jsonResponse({ error: 'race_lookup_failed' }, 500);
    if (!membership) return jsonResponse({ error: 'not_a_race_participant' }, 403);

    if (body.action === 'leave') {
      const { data: status, error } = await client.rpc('leave_stranger_race', {
        p_race_id: race.id, p_profile_id: profile.id,
      });
      if (error) return jsonResponse({ error: 'leave_failed' }, 500);
      return jsonResponse({ status });
    }
    if (body.action === 'accept_route') {
      const { data: status, error } = await client.rpc('accept_friend_race_route', {
        p_race_id: race.id, p_profile_id: profile.id,
      });
      if (error) return jsonResponse({ error: error.message.includes('route_distance_mismatch')
        ? 'route_distance_mismatch' : 'route_accept_failed' }, 409);
      return jsonResponse({ status });
    }
    if (body.action === 'start_ready') {
      if (typeof body.ready !== 'boolean') return jsonResponse({ error: 'invalid_ready_state' }, 400);
      const { data: status, error } = await client.rpc('set_friend_race_start_ready', {
        p_race_id: race.id, p_profile_id: profile.id, p_ready: body.ready,
      });
      if (error) return jsonResponse({ error: error.message.includes('verification_required')
        ? 'verification_required' : 'start_ready_failed' }, 409);
      return jsonResponse({ status });
    }

    if (['countdown', 'active', 'route_review', 'ready', 'verification'].includes(race.status)) {
      // Starts a due countdown and applies verification, inactivity, and time-limit expiry.
      const { error } = await client.rpc('expire_stale_race', { p_race_id: race.id });
      if (error) return jsonResponse({ error: 'race_status_failed' }, 500);
    }
    const { data: currentRace, error: currentError } = await client.from('races')
      .select('status, scheduled_start_at, started_at, verification_started_at').eq('id', race.id).single();
    if (currentError) return jsonResponse({ error: 'race_status_failed' }, 500);
    const { data: participants, error: participantsError } = await client.from('race_participants')
      .select('profile_id, route_accepted_at, route_distance_m, elevation_gain_m, start_ready_at')
      .eq('race_id', race.id);
    if (participantsError) return jsonResponse({ error: 'race_status_failed' }, 500);
    const ids = (participants ?? []).map((item) => item.profile_id);
    const { data: profiles, error: handlesError } = await client.from('profiles')
      .select('id, runner_handle').in('id', ids);
    if (handlesError) return jsonResponse({ error: 'race_status_failed' }, 500);
    const handles = new Map((profiles ?? []).map((item) => [item.id, item.runner_handle]));
    const { data: checks, error: checksError } = await client.from('race_verifications')
      .select('profile_id, check_kind, verified').eq('race_id', race.id);
    if (checksError) return jsonResponse({ error: 'race_status_failed' }, 500);
    return jsonResponse({
      raceId: race.id, status: currentRace.status, distanceKm: race.distance_km,
      scheduledStartAt: currentRace.scheduled_start_at, startedAt: currentRace.started_at,
      // Each runner must pass their Selfie Check within 6 minutes of the match.
      verificationDeadline: currentRace.verification_started_at
        ? new Date(Date.parse(currentRace.verification_started_at) + 6 * 60 * 1000).toISOString() : null,
      serverTime: new Date().toISOString(),
      participants: (participants ?? []).map((participant) => ({
        handle: handles.get(participant.profile_id) ?? 'runner',
        isSelf: participant.profile_id === profile.id,
        routeDistanceMeters: participant.route_distance_m,
        elevationGainMeters: participant.elevation_gain_m === null ? null : Number(participant.elevation_gain_m),
        routeAccepted: participant.route_accepted_at !== null,
        startReady: participant.start_ready_at !== null,
        selfieVerified: (checks ?? []).some((check) => check.profile_id === participant.profile_id && check.check_kind === 'selfie' && check.verified),
        officialIdVerified: (checks ?? []).some((check) => check.profile_id === participant.profile_id && check.check_kind === 'official_id' && check.verified),
      })),
    });
  },
};
