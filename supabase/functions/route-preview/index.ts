import { createClient } from '@supabase/supabase-js';
import { getPrivyUserId, privyVerificationConfigured } from '../_shared/auth.ts';
import { corsHeaders, jsonResponse } from '../_shared/http.ts';

type Coordinate = [number, number, number];
type RouteFeature = {
  geometry?: { coordinates?: unknown };
  properties?: { summary?: { distance?: unknown } };
};

// Every route is cut to exactly the preset along its own path, so both runners
// cover the same distance. The database accepts routes within this tolerance.
const DISTANCE_TOLERANCE_M = 5;

function getAdminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Server database settings are missing.');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function validCoordinates(value: unknown): value is Coordinate[] {
  return Array.isArray(value) && value.length >= 2 && value.length <= 10000 && value.every((point) =>
    Array.isArray(point) && point.length >= 3 && point.slice(0, 3).every((part) => typeof part === 'number' && Number.isFinite(part))
  );
}

// Same haversine as race-progress, so the measured route length is exactly the
// length that live progress is scored against.
function distanceBetweenMeters(a: Coordinate, b: Coordinate) {
  const radians = Math.PI / 180;
  const lat1 = a[1] * radians;
  const lat2 = b[1] * radians;
  const latDelta = (b[1] - a[1]) * radians;
  const lonDelta = (b[0] - a[0]) * radians;
  const haversine = Math.sin(latDelta / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(lonDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function pathLength(coordinates: Coordinate[]) {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) total += distanceBetweenMeters(coordinates[index - 1], coordinates[index]);
  return total;
}

function buildElevationProfile(coordinates: Coordinate[]) {
  let distanceMeters = 0;
  let ascentMeters = 0;
  const profile = coordinates.map((coordinate, index) => {
    if (index > 0) {
      distanceMeters += distanceBetweenMeters(coordinates[index - 1], coordinate);
      ascentMeters += Math.max(0, coordinate[2] - coordinates[index - 1][2]);
    }
    return { distanceMeters: Math.round(distanceMeters), elevationMeters: coordinate[2] };
  });
  return { profile, distanceMeters, ascentMeters };
}

/** The path's first `meters`, ending at an interpolated point; null if the path is shorter. */
function truncateToDistance(coordinates: Coordinate[], meters: number): Coordinate[] | null {
  const result: Coordinate[] = [coordinates[0]];
  let remaining = meters;
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const next = coordinates[index];
    const segment = distanceBetweenMeters(previous, next);
    if (segment <= 0) continue;
    if (segment >= remaining) {
      const fraction = remaining / segment;
      result.push([
        previous[0] + (next[0] - previous[0]) * fraction,
        previous[1] + (next[1] - previous[1]) * fraction,
        previous[2] + (next[2] - previous[2]) * fraction,
      ]);
      return result;
    }
    result.push(next);
    remaining -= segment;
  }
  return null;
}

/** Run out along the path for half the distance, then back the same way. */
function buildOutAndBack(coordinates: Coordinate[], meters: number): Coordinate[] | null {
  const outward = truncateToDistance(coordinates, meters / 2);
  return outward ? [...outward, ...outward.slice(0, -1).reverse()] : null;
}

export default {
  async fetch(request: Request) {
    if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
    if (!privyVerificationConfigured()) return jsonResponse({ error: 'server_not_configured' }, 503);

    const privyUserId = await getPrivyUserId(request);
    if (!privyUserId) return jsonResponse({ error: 'unauthorized' }, 401);
    const orsApiKey = Deno.env.get('ORS_API_KEY');
    if (!orsApiKey) return jsonResponse({ error: 'route_provider_not_configured' }, 503);

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: 'invalid_request' }, 400);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonResponse({ error: 'invalid_request' }, 400);
    }
    const input = payload as { raceId?: unknown; latitude?: unknown; longitude?: unknown; forceRefresh?: unknown };
    if (typeof input.raceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.raceId)) {
      return jsonResponse({ error: 'invalid_race_id' }, 400);
    }
    if (typeof input.latitude !== 'number' || !Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90 ||
        typeof input.longitude !== 'number' || !Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) {
      return jsonResponse({ error: 'invalid_start_point' }, 400);
    }

    let client;
    try {
      client = getAdminClient();
    } catch {
      return jsonResponse({ error: 'server_not_configured' }, 503);
    }

    const { data: profile, error: profileError } = await client
      .from('profiles').select('id').eq('privy_user_id', privyUserId).maybeSingle();
    if (profileError) return jsonResponse({ error: 'profile_lookup_failed' }, 500);
    if (!profile) return jsonResponse({ error: 'profile_required' }, 409);

    const { data: race, error: raceError } = await client
      .from('races').select('id, mode, distance_km, status').eq('id', input.raceId).maybeSingle();
    if (raceError) return jsonResponse({ error: 'race_lookup_failed' }, 500);
    if (!race || race.status !== 'route_review') return jsonResponse({ error: 'race_not_ready_for_routes' }, 409);
    if (race.mode === 'strangers') {
      // Strangers verify before their start point goes to the route provider.
      const { data: selfie, error: selfieError } = await client.from('race_verifications')
        .select('verified').eq('race_id', race.id).eq('profile_id', profile.id).eq('check_kind', 'selfie').maybeSingle();
      if (selfieError) return jsonResponse({ error: 'verification_lookup_failed' }, 500);
      if (!selfie?.verified) return jsonResponse({ error: 'verification_required' }, 409);
    }

    const { data: participant, error: participantError } = await client
      .from('race_participants')
      .select('route_coordinates, route_elevation_profile, route_distance_m, route_shape, elevation_gain_m, start_latitude, start_longitude')
      .eq('race_id', race.id)
      .eq('profile_id', profile.id)
      .maybeSingle();
    if (participantError) return jsonResponse({ error: 'participant_lookup_failed' }, 500);
    if (!participant) return jsonResponse({ error: 'not_a_race_participant' }, 403);

    const targetDistanceKm = race.distance_km as 1 | 3 | 5 | 10;
    const targetMeters = targetDistanceKm * 1000;
    const isDoubleLoop = targetDistanceKm === 10;
    const lapMeters = targetMeters / (isDoubleLoop ? 2 : 1);
    const sameStart = typeof participant.start_latitude === 'number' && typeof participant.start_longitude === 'number' &&
      Math.abs(participant.start_latitude - input.latitude) < 0.00001 &&
      Math.abs(participant.start_longitude - input.longitude) < 0.00001;
    if (input.forceRefresh !== true && participant.route_coordinates && participant.route_distance_m && participant.elevation_gain_m !== null && sameStart &&
        Math.abs(participant.route_distance_m - targetMeters) <= DISTANCE_TOLERANCE_M) {
      return jsonResponse({
        raceId: race.id,
        targetDistanceKm,
        distanceMeters: participant.route_distance_m,
        routeShape: participant.route_shape,
        elevationGainMeters: Number(participant.elevation_gain_m),
        loopRepeats: isDoubleLoop ? 2 : 1,
        coordinates: participant.route_coordinates,
        elevationProfile: participant.route_elevation_profile,
      });
    }

    const { data: generationClaimed, error: claimError } = await client.rpc('claim_route_preview_generation', {
      p_race_id: race.id,
      p_profile_id: profile.id,
    });
    if (claimError) return jsonResponse({ error: 'route_generation_failed' }, 500);
    if (!generationClaimed) return jsonResponse({ error: 'not_a_race_participant' }, 403);

    const randomSeed = crypto.getRandomValues(new Uint8Array(1))[0] % 91;
    // Ask for a slightly long loop: anything at least one lap long is trimmed
    // to the exact distance, ending at a finish point on the route.
    let requestedLapMeters = Math.min(5900, lapMeters * 1.08);
    let chosen: { coordinates: Coordinate[]; shape: 'loop' | 'out_and_back' } | null = null;

    for (let attempt = 0; attempt < 2 && !chosen; attempt += 1) {
      let providerResponse: Response;
      try {
        providerResponse = await fetch('https://api.heigit.org/openrouteservice/v2/directions/foot-walking/geojson', {
          method: 'POST',
          headers: {
            Authorization: orsApiKey,
            'Content-Type': 'application/json',
            Accept: 'application/geo+json, application/json',
          },
          body: JSON.stringify({
            coordinates: [[input.longitude, input.latitude]],
            elevation: true,
            instructions: false,
            options: { round_trip: { length: Math.round(requestedLapMeters), points: 3, seed: randomSeed } },
          }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        return jsonResponse({ error: 'route_provider_unreachable' }, 502);
      }
      if (!providerResponse.ok) {
        return jsonResponse({ error: providerResponse.status === 429 ? 'route_provider_quota' : 'route_provider_error' }, 502);
      }

      let providerResult: { features?: RouteFeature[] };
      try {
        providerResult = await providerResponse.json();
      } catch {
        return jsonResponse({ error: 'route_provider_invalid_response' }, 502);
      }
      const lap = providerResult.features?.[0]?.geometry?.coordinates;
      if (!validCoordinates(lap)) return jsonResponse({ error: 'route_provider_missing_elevation' }, 502);

      const lapLength = pathLength(lap);
      const fullPath = isDoubleLoop ? [...lap, ...lap.slice(1)] : lap;
      const trimmed = truncateToDistance(fullPath, targetMeters);
      if (trimmed) {
        chosen = { coordinates: trimmed, shape: 'loop' };
        break;
      }
      if (attempt === 1) {
        // Still short: run out along the loop and back for an exact distance.
        const outAndBack = buildOutAndBack(lap, lapMeters);
        if (outAndBack) chosen = { coordinates: isDoubleLoop ? [...outAndBack, ...outAndBack.slice(1)] : outAndBack, shape: 'out_and_back' };
      }
      requestedLapMeters = Math.min(5900, requestedLapMeters * (lapMeters * 1.08) / Math.max(1, lapLength));
    }
    if (!chosen) return jsonResponse({ error: 'route_distance_unavailable' }, 422);

    const stats = buildElevationProfile(chosen.coordinates);
    const distanceMeters = Math.round(stats.distanceMeters);
    if (Math.abs(distanceMeters - targetMeters) > DISTANCE_TOLERANCE_M) return jsonResponse({ error: 'route_distance_unavailable' }, 422);
    const elevationGainMeters = Math.round(stats.ascentMeters * 100) / 100;

    const { error: updateError } = await client
      .from('race_participants')
      .update({
        route_coordinates: chosen.coordinates,
        route_elevation_profile: stats.profile,
        route_distance_m: distanceMeters,
        route_shape: chosen.shape,
        elevation_gain_m: elevationGainMeters,
        start_latitude: input.latitude,
        start_longitude: input.longitude,
        route_accepted_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('race_id', race.id)
      .eq('profile_id', profile.id);

    if (updateError) return jsonResponse({ error: 'route_save_failed' }, 500);

    return jsonResponse({
      raceId: race.id,
      targetDistanceKm,
      distanceMeters,
      routeShape: chosen.shape,
      elevationGainMeters,
      loopRepeats: isDoubleLoop ? 2 : 1,
      coordinates: chosen.coordinates,
      elevationProfile: stats.profile,
    });
  },
};
