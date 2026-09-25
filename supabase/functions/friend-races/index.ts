import { createClient } from '@supabase/supabase-js';
import { getPrivyUserId, privyVerificationConfigured } from '../_shared/auth.ts';
import { corsHeaders, jsonResponse } from '../_shared/http.ts';

const inviteAlphabet = 'abcdefghijklmnopqrstuvwxyz234567';

function getAdminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Server database settings are missing.');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function newInviteCode() {
  const random = crypto.getRandomValues(new Uint8Array(16));
  const raw = Array.from(random, (byte) => inviteAlphabet[byte & 31]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

async function hashInviteCode(code: string) {
  const normalized = code.toLowerCase().replace(/[^a-z2-7]/g, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
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
    const body = payload as { action?: unknown; distanceKm?: unknown; inviteCode?: unknown };

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

    if (body.action === 'create') {
      const distanceKm = Number(body.distanceKm);
      if (![1, 3, 5, 10].includes(distanceKm)) return jsonResponse({ error: 'invalid_distance' }, 400);

      const inviteCode = newInviteCode();
      const inviteHash = await hashInviteCode(inviteCode);
      const { data: raceId, error } = await client.rpc('create_friend_race', {
        p_creator_profile_id: profile.id,
        p_distance_km: distanceKm,
        p_invite_token_hash: inviteHash,
      });

      if (error || typeof raceId !== 'string') return jsonResponse({ error: 'race_create_failed' }, 500);
      return jsonResponse({ raceId, inviteCode, distanceKm, expiresInHours: 48 }, 201);
    }

    if (body.action === 'join') {
      if (typeof body.inviteCode !== 'string') return jsonResponse({ error: 'invalid_invite_code' }, 400);
      const normalizedCode = body.inviteCode.toLowerCase().replace(/[^a-z2-7]/g, '');
      if (normalizedCode.length !== 16) return jsonResponse({ error: 'invite_unavailable' }, 404);
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
      const { data: race, error: raceError } = await client.from('races').select('distance_km').eq('id', raceId).single();
      if (raceError) return jsonResponse({ error: 'race_join_failed' }, 500);
      return jsonResponse({ raceId, distanceKm: race.distance_km, status: 'route_review' });
    }

    return jsonResponse({ error: 'invalid_action' }, 400);
  },
};
