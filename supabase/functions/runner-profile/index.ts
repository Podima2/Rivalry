import { createClient } from '@supabase/supabase-js';
import { getPrivyUserId, privyVerificationConfigured } from '../_shared/auth.ts';
import { corsHeaders, jsonResponse } from '../_shared/http.ts';

function getAdminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) throw new Error('Server database settings are missing.');

  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export default {
  async fetch(request: Request) {
    if (request.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }

    if (request.method !== 'GET' && request.method !== 'POST') {
      return jsonResponse({ error: 'method_not_allowed' }, 405);
    }

    if (!privyVerificationConfigured()) return jsonResponse({ error: 'server_not_configured' }, 503);
    const privyUserId = await getPrivyUserId(request);
    if (!privyUserId) return jsonResponse({ error: 'unauthorized' }, 401);

    let client;
    try {
      client = getAdminClient();
    } catch {
      return jsonResponse({ error: 'server_not_configured' }, 503);
    }

    if (request.method === 'GET') {
      const { data, error } = await client
        .from('profiles')
        .select('runner_handle')
        .eq('privy_user_id', privyUserId)
        .maybeSingle();

      if (error) return jsonResponse({ error: 'profile_lookup_failed' }, 500);
      return jsonResponse({ handle: data?.runner_handle ?? null });
    }

    let requestedHandle: unknown;
    try {
      const body = await request.json();
      requestedHandle = body?.handle;
    } catch {
      return jsonResponse({ error: 'invalid_request' }, 400);
    }

    if (typeof requestedHandle !== 'string') {
      return jsonResponse({ error: 'invalid_handle' }, 400);
    }

    const handle = requestedHandle.trim().toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
      return jsonResponse({ error: 'invalid_handle' }, 400);
    }

    const { data: existing, error: lookupError } = await client
      .from('profiles')
      .select('id')
      .eq('privy_user_id', privyUserId)
      .maybeSingle();

    if (lookupError) return jsonResponse({ error: 'profile_lookup_failed' }, 500);

    const result = existing
      ? await client.from('profiles').update({ runner_handle: handle, updated_at: new Date().toISOString() }).eq('id', existing.id)
      : await client.from('profiles').insert({ privy_user_id: privyUserId, runner_handle: handle });

    if (result.error?.code === '23505') {
      return jsonResponse({ error: 'handle_unavailable' }, 409);
    }
    if (result.error) return jsonResponse({ error: 'profile_save_failed' }, 500);

    return jsonResponse({ handle });
  },
};
