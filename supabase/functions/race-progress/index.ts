import { createClient } from '@supabase/supabase-js';
import { getPrivyUserId, privyVerificationConfigured } from '../_shared/auth.ts';
import { corsHeaders, jsonResponse } from '../_shared/http.ts';

type Coordinate = [number, number, number];

function adminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Server database settings are missing.');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function distance(a: Coordinate, b: Coordinate) {
  const toRadians = Math.PI / 180;
  const deltaLatitude = (b[1] - a[1]) * toRadians;
  const deltaLongitude = (b[0] - a[0]) * toRadians;
  const latitudeA = a[1] * toRadians;
  const latitudeB = b[1] * toRadians;
  const haversine = Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(deltaLongitude / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function validRoute(value: unknown): value is Coordinate[] {
  return Array.isArray(value) && value.length >= 2 && value.length <= 5000 && value.every((item) =>
    Array.isArray(item) && item.length >= 2 &&
    typeof item[0] === 'number' && Number.isFinite(item[0]) &&
    typeof item[1] === 'number' && Number.isFinite(item[1]));
}

function projectProgress(route: Coordinate[], latitude: number, longitude: number, previous: number, maxAdvance: number) {
  let traversed = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  let best: { progress: number; distance: number; score: number } | null = null;
  for (let index = 1; index < route.length; index += 1) {
    const a = route[index - 1];
    const b = route[index];
    const segment = distance(a, b);
    if (segment < 0.1) continue;
    const metersLongitude = Math.cos(latitude * Math.PI / 180) * 111_320;
    const ax = (a[0] - longitude) * metersLongitude;
    const ay = (a[1] - latitude) * 111_320;
    const bx = (b[0] - longitude) * metersLongitude;
    const by = (b[1] - latitude) * 111_320;
    const vx = bx - ax;
    const vy = by - ay;
    const fraction = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / (vx * vx + vy * vy)));
    const projectedMeters = Math.hypot(ax + fraction * vx, ay + fraction * vy);
    nearestDistance = Math.min(nearestDistance, projectedMeters);
    const progress = traversed + fraction * segment;
    if (progress >= previous - 15 && progress <= previous + maxAdvance) {
      // At an out-and-back overlap, favor the nearest valid point ahead.
      const score = projectedMeters + Math.max(0, progress - previous) * 0.001;
      if (!best || score < best.score) best = { progress, distance: projectedMeters, score };
    }
    traversed += segment;
  }
  return { best, nearestDistance };
}

export default {
  async fetch(request: Request) {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
    if (!privyVerificationConfigured()) return jsonResponse({ error: 'server_not_configured' }, 503);
    const privyUserId = await getPrivyUserId(request);
    if (!privyUserId) return jsonResponse({ error: 'unauthorized' }, 401);

    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
      body = parsed as Record<string, unknown>;
    } catch {
      return jsonResponse({ error: 'invalid_request' }, 400);
    }
    if (typeof body.raceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.raceId)) {
      return jsonResponse({ error: 'invalid_race_id' }, 400);
    }
    if (!['snapshot', 'location', 'dnf', 'dismiss'].includes(String(body.action))) {
      return jsonResponse({ error: 'invalid_action' }, 400);
    }

    let client: ReturnType<typeof adminClient>;
    try { client = adminClient(); } catch { return jsonResponse({ error: 'server_not_configured' }, 503); }
    const { data: profile, error: profileError } = await client.from('profiles')
      .select('id').eq('privy_user_id', privyUserId).maybeSingle();
    if (profileError) return jsonResponse({ error: 'profile_lookup_failed' }, 500);
    if (!profile) return jsonResponse({ error: 'profile_required' }, 409);

    if (body.action === 'snapshot') {
      // Applies inactivity DNFs and the race time limit before reporting state.
      const { error: expireError } = await client.rpc('expire_stale_race', { p_race_id: body.raceId });
      if (expireError) return jsonResponse({ error: 'progress_lookup_failed' }, 500);
    }

    const { data: race, error: raceError } = await client.from('races')
      .select('id, mode, status, distance_km, started_at').eq('id', body.raceId).maybeSingle();
    if (raceError) return jsonResponse({ error: 'race_lookup_failed' }, 500);
    if (!race || !['friends', 'strangers'].includes(race.mode)) return jsonResponse({ error: 'race_unavailable' }, 404);
    const { data: participants, error: participantsError } = await client.from('race_participants')
      .select('profile_id, state, route_coordinates, route_distance_m, progress_m, progress_anchor_latitude, progress_anchor_longitude, off_route_count, off_route_ms, gps_gap_ms, longest_gps_gap_ms, dnf_reason, elapsed_ms, result_valid')
      .eq('race_id', race.id);
    if (participantsError) return jsonResponse({ error: 'race_lookup_failed' }, 500);
    const own = participants?.find((participant) => participant.profile_id === profile.id);
    if (!own) return jsonResponse({ error: 'not_a_race_participant' }, 403);

    if (body.action === 'location') {
      const latitude = body.latitude;
      const longitude = body.longitude;
      const accuracy = body.accuracy;
      if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
          typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180 ||
          typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 500) {
        return jsonResponse({ error: 'invalid_location' }, 400);
      }
      if (race.status !== 'active' || own.state !== 'running') return jsonResponse({ error: 'race_not_running' }, 409);
      if (!validRoute(own.route_coordinates) || !own.route_distance_m) return jsonResponse({ error: 'route_missing' }, 409);
      if (accuracy > 50) return jsonResponse({ error: 'location_inaccurate' }, 422);

      const { data: latest, error: latestError } = await client.from('race_gps_points')
        .select('captured_at').eq('race_id', race.id).eq('profile_id', profile.id)
        .order('captured_at', { ascending: false }).limit(1).maybeSingle();
      if (latestError) return jsonResponse({ error: 'progress_lookup_failed' }, 500);
      const previous = Number(own.progress_m ?? 0);
      const lastTime = latest?.captured_at ?? race.started_at;
      const elapsedSeconds = lastTime ? Math.max(1, (Date.now() - Date.parse(lastTime)) / 1000) : 1;
      const projected = projectProgress(own.route_coordinates, latitude, longitude, previous,
        Math.max(30, elapsedSeconds * 8 + 20));
      const startPoint = own.route_coordinates[0];
      const nearStart = distance([longitude, latitude, 0], startPoint) <= Math.max(30, accuracy + 10);
      const anchor = typeof own.progress_anchor_latitude === 'number' && typeof own.progress_anchor_longitude === 'number'
        ? [own.progress_anchor_longitude, own.progress_anchor_latitude, 0] as Coordinate : null;
      const eligibleToStart = previous > 0 || anchor !== null || nearStart;
      const routeTolerance = Math.max(30, accuracy + 12);
      const onRoute = eligibleToStart && projected.nearestDistance <= routeTolerance;
      const endpoint = own.route_coordinates[own.route_coordinates.length - 1];
      const nearFinish = distance([longitude, latitude, 0], endpoint) <= routeTolerance;
      const finishCandidate = projected.best !== null && projected.best.progress >= own.route_distance_m - 25 && nearFinish;
      const movementMeters = anchor ? distance(anchor, [longitude, latitude, 0]) : 0;
      const movementNeeded = finishCandidate ? Math.max(20, accuracy * 1.3) : Math.max(40, accuracy * 2);
      // Advance only to a matched point that is itself near the runner; being
      // near another part of the route (a shortcut) keeps progress in place.
      const matchedNearby = projected.best !== null && projected.best.distance <= routeTolerance;
      const advancedEnough = projected.best !== null && projected.best.progress - previous >= (finishCandidate ? 15 : 25);
      const progress = onRoute && anchor && matchedNearby && movementMeters >= movementNeeded && advancedEnough && projected.best
        ? Math.min(own.route_distance_m, Math.max(previous, Math.round(projected.best.progress))) : previous;
      const finish = onRoute && nearFinish && progress >= own.route_distance_m - 25;
      const { data: state, error: saveError } = await client.rpc('record_friend_race_fix', {
        p_race_id: race.id,
        p_profile_id: profile.id,
        p_latitude: latitude,
        p_longitude: longitude,
        p_accuracy_m: accuracy,
        p_progress_m: progress,
        // null = not at the start yet: recorded, but not an off-route fix.
        p_on_route: eligibleToStart ? onRoute : null,
        p_finish: finish,
      });
      if (saveError) return jsonResponse({ error: 'progress_save_failed' }, 500);
      return jsonResponse({ state, progressMeters: progress, onRoute,
        distanceFromRouteMeters: Number.isFinite(projected.nearestDistance) ? Math.round(projected.nearestDistance) : null,
        distanceFromStartMeters: Math.round(distance([longitude, latitude, 0], startPoint)),
        waitingForStart: !eligibleToStart });
    }

    if (body.action === 'dismiss') {
      // Leave the results lobby; the pairing no longer appears on this runner's home.
      if (!['completed', 'cancelled'].includes(race.status)) return jsonResponse({ error: 'race_not_finished' }, 409);
      const { error } = await client.from('race_participants').update({ result_dismissed_at: new Date().toISOString() })
        .eq('race_id', race.id).eq('profile_id', profile.id);
      if (error) return jsonResponse({ error: 'dismiss_failed' }, 500);
      return jsonResponse({ dismissed: true });
    }

    if (body.action === 'dnf') {
      const { data: state, error } = await client.rpc('forfeit_friend_race', {
        p_race_id: race.id, p_profile_id: profile.id,
      });
      if (error) return jsonResponse({ error: 'dnf_failed' }, 500);
      return jsonResponse({ state });
    }

    if (!['active', 'completed'].includes(race.status)) return jsonResponse({ error: 'race_not_started' }, 409);
    const ids = participants.map((participant) => participant.profile_id);
    const { data: profiles, error: handlesError } = await client.from('profiles')
      .select('id, runner_handle').in('id', ids);
    if (handlesError) return jsonResponse({ error: 'progress_lookup_failed' }, 500);
    const handles = new Map((profiles ?? []).map((item) => [item.id, item.runner_handle]));
    const latestByProfile = new Map<string, Record<string, unknown>>();
    if (race.status === 'active') {
      const visibleParticipants = race.mode === 'friends' ? participants : participants.filter((participant) => participant.profile_id === profile.id);
      const latestQueries = await Promise.all(visibleParticipants.map((participant) => client.from('race_gps_points')
        .select('profile_id, latitude, longitude, accuracy_m, captured_at, on_route')
        .eq('race_id', race.id).eq('profile_id', participant.profile_id)
        .order('captured_at', { ascending: false }).limit(1).maybeSingle()));
      if (latestQueries.some((query) => query.error)) return jsonResponse({ error: 'progress_lookup_failed' }, 500);
      for (const query of latestQueries) if (query.data) latestByProfile.set(query.data.profile_id, query.data);
    }
    const { data: summaries, error: summariesError } = race.status === 'completed'
      ? await client.from('race_summaries').select('profile_id, outcome, elapsed_ms').eq('race_id', race.id)
      : { data: [], error: null };
    if (summariesError) return jsonResponse({ error: 'progress_lookup_failed' }, 500);
    const summaryByProfile = new Map((summaries ?? []).map((summary) => [summary.profile_id, summary]));
    return jsonResponse({
      raceId: race.id,
      mode: race.mode,
      status: race.status,
      distanceKm: race.distance_km,
      ownRoute: own.route_coordinates,
      participants: participants.map((participant) => ({
        handle: handles.get(participant.profile_id) ?? 'runner',
        isSelf: participant.profile_id === profile.id,
        state: participant.state,
        progressMeters: participant.progress_m,
        routeDistanceMeters: participant.route_distance_m,
        offRouteCount: participant.off_route_count,
        offRouteMs: Number(participant.off_route_ms ?? 0),
        gpsGapMs: Number(participant.gps_gap_ms ?? 0),
        longestGpsGapMs: Number(participant.longest_gps_gap_ms ?? 0),
        dnfReason: participant.dnf_reason,
        resultValid: participant.result_valid,
        elapsedMs: participant.elapsed_ms,
        outcome: summaryByProfile.get(participant.profile_id)?.outcome ?? null,
        latestLocation: race.mode === 'strangers' && participant.profile_id !== profile.id
          ? null : latestByProfile.get(participant.profile_id) ?? null,
      })),
    });
  },
};
