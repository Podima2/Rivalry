import { createClient } from '@supabase/supabase-js';
import { getPrivyUserId, privyVerificationConfigured } from '../_shared/auth.ts';
import { corsHeaders, jsonResponse } from '../_shared/http.ts';

function getAdminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Server database settings are missing.');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function newInviteCode() {
  const random = new Uint16Array(1);
  do {
    crypto.getRandomValues(random);
  } while (random[0] >= 60000);
  return String(random[0] % 10000).padStart(4, '0');
}

async function hashInviteCode(code: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request: Request) {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
    if (!privyVerificationConfigured()) return jsonResponse({ error: 'server_not_configured' }, 503);

    const privyUserId = await getPrivyUserId(request);
    if (!privyUserId) return jsonResponse({ error: 'unauthorized' }, 401);

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: 'invalid_request' }, 400);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonResponse({ error: 'invalid_request' }, 400);
    }
    const body = payload as { action?: unknown; distanceKm?: unknown; inviteCode?: unknown; raceId?: unknown; ready?: unknown };

    let client;
    try {
      client = getAdminClient();
    } catch {
      return jsonResponse({ error: 'server_not_configured' }, 503);
    }

    const { data: profile, error: profileError } = await client
      .from('profiles')
      .select('id')
      .eq('privy_user_id', privyUserId)
      .maybeSingle();

    if (profileError) return jsonResponse({ error: 'profile_lookup_failed' }, 500);
    if (!profile) return jsonResponse({ error: 'profile_required' }, 409);

    if (body.action === 'active') {
      const { data: memberships, error: membershipError } = await client
        .from('race_participants')
        .select('race_id, result_dismissed_at')
        .eq('profile_id', profile.id)
        .order('created_at', { ascending: false })
        .limit(20);
      if (membershipError) return jsonResponse({ error: 'race_lookup_failed' }, 500);
      const raceIds = (memberships ?? []).map((membership) => membership.race_id);
      if (!raceIds.length) return jsonResponse({ raceId: null });
      const { data: races, error: raceError } = await client
        .from('races')
        .select('id, distance_km, status, completed_at')
        .in('id', raceIds)
        .eq('mode', 'friends')
        .in('status', ['waiting_for_opponent', 'route_review', 'ready', 'countdown', 'active', 'completed'])
        .order('created_at', { ascending: false });
      if (raceError) return jsonResponse({ error: 'race_lookup_failed' }, 500);
      // A finished race stays in its results lobby until this runner leaves it.
      const dismissed = new Set((memberships ?? []).filter((item) => item.result_dismissed_at).map((item) => item.race_id));
      const race = (races ?? []).find((item) => item.status !== 'completed' ||
        (!dismissed.has(item.id) && Date.parse(item.completed_at) > Date.now() - 24 * 60 * 60 * 1000));
      return jsonResponse(race
        ? { raceId: race.id, distanceKm: race.distance_km, status: race.status }
        : { raceId: null });
    }

    if (body.action === 'create') {
      const distanceKm = Number(body.distanceKm);
      if (![1, 3, 5, 10].includes(distanceKm)) return jsonResponse({ error: 'invalid_distance' }, 400);

      for (let attempt = 0; attempt < 8; attempt++) {
        const inviteCode = newInviteCode();
        const inviteHash = await hashInviteCode(inviteCode);
        const { data: raceId, error } = await client.rpc('create_friend_race', {
          p_creator_profile_id: profile.id,
          p_distance_km: distanceKm,
          p_invite_token_hash: inviteHash,
        });
        if (error?.code === '23505') continue;
        if (error || typeof raceId !== 'string') return jsonResponse({ error: 'race_create_failed' }, 500);
        return jsonResponse({ raceId, inviteCode, distanceKm, expiresInMinutes: 10 }, 201);
      }
      return jsonResponse({ error: 'invite_code_unavailable' }, 503);
    }

    if (body.action === 'join') {
      if (typeof body.inviteCode !== 'string') return jsonResponse({ error: 'invalid_invite_code' }, 400);
      const normalizedCode = body.inviteCode.trim();
      if (!/^\d{4}$/.test(normalizedCode)) return jsonResponse({ error: 'invite_unavailable' }, 404);
      const { data: attemptAllowed, error: attemptError } = await client.rpc('record_friend_invite_join_attempt', {
        p_profile_id: profile.id,
      });
      if (attemptError) return jsonResponse({ error: 'invite_attempt_failed' }, 500);
      if (!attemptAllowed) return jsonResponse({ error: 'invite_rate_limited' }, 429);
      const inviteHash = await hashInviteCode(normalizedCode);
      const { data: raceId, error } = await client.rpc('join_friend_race', {
        p_joining_profile_id: profile.id,
        p_invite_token_hash: inviteHash,
      });

      if (error) {
        if (error.message.includes('invite_unavailable')) return jsonResponse({ error: 'invite_unavailable' }, 404);
        return jsonResponse({ error: 'race_join_failed' }, 500);
      }
      if (typeof raceId !== 'string') return jsonResponse({ error: 'race_join_failed' }, 500);
      await client.rpc('dismiss_completed_races', { p_profile_id: profile.id });
      const { data: race, error: raceError } = await client.from('races').select('distance_km').eq('id', raceId).single();
      if (raceError) return jsonResponse({ error: 'race_join_failed' }, 500);
      return jsonResponse({ raceId, distanceKm: race.distance_km, status: 'route_review' });
    }

    if (body.action === 'status' || body.action === 'accept_route' || body.action === 'start_ready') {
      if (typeof body.raceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.raceId)) {
        return jsonResponse({ error: 'invalid_race_id' }, 400);
      }
      const { data: race, error: raceError } = await client
        .from('races').select('id, mode, distance_km, status, scheduled_start_at, started_at').eq('id', body.raceId).maybeSingle();
      if (raceError) return jsonResponse({ error: 'race_lookup_failed' }, 500);
      if (!race || race.mode !== 'friends') return jsonResponse({ error: 'race_unavailable' }, 404);

      if (body.action === 'accept_route') {
        const { data: nextStatus, error } = await client.rpc('accept_friend_race_route', {
          p_race_id: race.id,
          p_profile_id: profile.id,
        });
        if (error) {
          if (error.message.includes('not_a_participant')) return jsonResponse({ error: 'not_a_race_participant' }, 403);
          if (error.message.includes('route_missing')) return jsonResponse({ error: 'route_missing' }, 409);
          if (error.message.includes('route_distance_mismatch')) return jsonResponse({ error: 'route_distance_mismatch' }, 409);
          return jsonResponse({ error: 'route_accept_failed' }, 500);
        }
        return jsonResponse({ raceId: race.id, status: nextStatus });
      }

      if (body.action === 'start_ready') {
        if (typeof body.ready !== 'boolean') return jsonResponse({ error: 'invalid_ready_state' }, 400);
        const { data: nextStatus, error } = await client.rpc('set_friend_race_start_ready', {
          p_race_id: race.id,
          p_profile_id: profile.id,
          p_ready: body.ready,
        });
        if (error) {
          if (error.message.includes('not_a_participant')) return jsonResponse({ error: 'not_a_race_participant' }, 403);
          if (error.message.includes('race_not_ready_for_start')) return jsonResponse({ error: 'race_not_ready_for_start' }, 409);
          return jsonResponse({ error: 'start_ready_failed' }, 500);
        }
        return jsonResponse({ raceId: race.id, status: nextStatus });
      }

      const { data: membership, error: membershipError } = await client.from('race_participants')
        .select('profile_id').eq('race_id', race.id).eq('profile_id', profile.id).maybeSingle();
      if (membershipError) return jsonResponse({ error: 'race_status_failed' }, 500);
      if (!membership) return jsonResponse({ error: 'not_a_race_participant' }, 403);

      if (['countdown', 'active', 'route_review', 'ready'].includes(race.status)) {
        // Starts a due countdown and applies inactivity and time-limit expiry.
        const { error } = await client.rpc('expire_stale_race', { p_race_id: race.id });
        if (error) return jsonResponse({ error: 'race_status_failed' }, 500);
      }

      const { data: currentRace, error: currentRaceError } = await client
        .from('races').select('status, scheduled_start_at, started_at').eq('id', race.id).single();
      if (currentRaceError) return jsonResponse({ error: 'race_status_failed' }, 500);

      const { data: participants, error: participantsError } = await client
        .from('race_participants')
        .select('profile_id, route_accepted_at, route_distance_m, elevation_gain_m, start_ready_at')
        .eq('race_id', race.id);
      if (participantsError) return jsonResponse({ error: 'race_status_failed' }, 500);
      if (!participants.some((participant) => participant.profile_id === profile.id)) {
        return jsonResponse({ error: 'not_a_race_participant' }, 403);
      }
      const profileIds = participants.map((participant) => participant.profile_id);
      const { data: profiles, error: handlesError } = await client
        .from('profiles').select('id, runner_handle').in('id', profileIds);
      if (handlesError) return jsonResponse({ error: 'race_status_failed' }, 500);
      const handles = new Map((profiles ?? []).map((item) => [item.id, item.runner_handle]));
      return jsonResponse({
        raceId: race.id,
        status: currentRace.status,
        distanceKm: race.distance_km,
        scheduledStartAt: currentRace.scheduled_start_at,
        startedAt: currentRace.started_at,
        serverTime: new Date().toISOString(),
        participants: participants.map((participant) => ({
          handle: handles.get(participant.profile_id) ?? 'runner',
          isSelf: participant.profile_id === profile.id,
          routeDistanceMeters: participant.route_distance_m,
          elevationGainMeters: participant.elevation_gain_m === null ? null : Number(participant.elevation_gain_m),
          routeAccepted: participant.route_accepted_at !== null,
          startReady: participant.start_ready_at !== null,
        })),
      });
    }

    return jsonResponse({ error: 'invalid_action' }, 400);
  },
};
