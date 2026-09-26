import { createClient } from '@supabase/supabase-js';
import { getPrivyUserId, privyVerificationConfigured } from '../_shared/auth.ts';
import { corsHeaders, jsonResponse } from '../_shared/http.ts';

type Coordinate = [number, number, number];
type RouteFeature = {
  geometry?: { coordinates?: unknown };
  properties?: {
    ascent?: unknown;
    summary?: { distance?: unknown };
  };
};

function getAdminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Server database settings are missing.');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function validCoordinates(value: unknown): value is Coordinate[] {
  return Array.isArray(value) && value.length >= 2 && value.length <= 5000 && value.every((point) =>
    Array.isArray(point) && point.length >= 3 && point.slice(0, 3).every((part) => typeof part === 'number' && Number.isFinite(part))
  );
}

function distanceBetweenMeters(a: Coordinate, b: Coordinate) {
  const radians = Math.PI / 180;
  const lat1 = a[1] * radians;
  const lat2 = b[1] * radians;
  const latDelta = (b[1] - a[1]) * radians;
  const lonDelta = (b[0] - a[0]) * radians;
  const haversine = Math.sin(latDelta / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(lonDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function buildElevationProfile(coordinates: Coordinate[]) {
  let distanceMeters = 0;
  const profile = coordinates.map((coordinate, index) => {
    if (index > 0) distanceMeters += distanceBetweenMeters(coordinates[index - 1], coordinate);
    return { distanceMeters: Math.round(distanceMeters), elevationMeters: coordinate[2] };
  });

  let calculatedAscent = 0;
  for (let index = 1; index < profile.length; index += 1) {
    const rise = profile[index].elevationMeters - profile[index - 1].elevationMeters;
    if (rise > 0) calculatedAscent += rise;
  }

  return { profile, distanceMeters, calculatedAscent };
}

function distanceToleranceMeters(targetMeters: number) {
  return Math.max(50, Math.round(targetMeters * 0.05));
}

function routeDistanceIsFair(distanceMeters: number, targetMeters: number, otherDistanceMeters: number | null) {
  const tolerance = distanceToleranceMeters(targetMeters);
  return Math.abs(distanceMeters - targetMeters) <= tolerance &&
    (otherDistanceMeters === null || Math.abs(distanceMeters - otherDistanceMeters) <= tolerance);
}

function buildOutAndBack(coordinates: Coordinate[], distanceMeters: number): Coordinate[] | null {
  const outward: Coordinate[] = [coordinates[0]];
  let remainingMeters = distanceMeters / 2;
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const next = coordinates[index];
    const segmentMeters = distanceBetweenMeters(previous, next);
    if (segmentMeters <= 0) continue;
    if (segmentMeters >= remainingMeters) {
      const fraction = remainingMeters / segmentMeters;
      outward.push([
        previous[0] + (next[0] - previous[0]) * fraction,
        previous[1] + (next[1] - previous[1]) * fraction,
        previous[2] + (next[2] - previous[2]) * fraction,
      ]);
      const result = [...outward, ...outward.slice(0, -1).reverse()];
      return validCoordinates(result) ? result : null;
    }
    outward.push(next);
    remainingMeters -= segmentMeters;
  }
  return null;
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
    const { data: otherParticipants, error: otherParticipantError } = await client
      .from('race_participants')
      .select('route_distance_m')
      .eq('race_id', race.id)
      .neq('profile_id', profile.id);
    if (otherParticipantError) return jsonResponse({ error: 'participant_lookup_failed' }, 500);
    const otherDistanceMeters = otherParticipants?.[0]?.route_distance_m ?? null;
    const otherFairDistanceMeters = typeof otherDistanceMeters === 'number' &&
      Math.abs(otherDistanceMeters - targetMeters) <= distanceToleranceMeters(targetMeters)
      ? otherDistanceMeters : null;
    const sameStart = typeof participant.start_latitude === 'number' && typeof participant.start_longitude === 'number' &&
      Math.abs(participant.start_latitude - input.latitude) < 0.00001 &&
      Math.abs(participant.start_longitude - input.longitude) < 0.00001;
    if (input.forceRefresh !== true && participant.route_coordinates && participant.route_distance_m && participant.elevation_gain_m !== null && sameStart &&
        routeDistanceIsFair(participant.route_distance_m, targetMeters, otherFairDistanceMeters)) {
      return jsonResponse({
        raceId: race.id,
        targetDistanceKm,
        distanceMeters: participant.route_distance_m,
        routeShape: participant.route_shape,
        elevationGainMeters: Number(participant.elevation_gain_m),
        loopRepeats: targetDistanceKm === 10 ? 2 : 1,
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

    const isDoubleLoop = targetDistanceKm === 10;
    const loopTargetMeters = targetMeters / (isDoubleLoop ? 2 : 1);
    const desiredMeters = otherFairDistanceMeters ?? targetMeters;
    let requestedLoopMeters = desiredMeters / (isDoubleLoop ? 2 : 1);
    const randomSeed = crypto.getRandomValues(new Uint8Array(1))[0] % 91;
    type Candidate = { coordinates: Coordinate[]; stats: ReturnType<typeof buildElevationProfile>; distanceMeters: number; ascentMeters: number; shape: 'loop' | 'out_and_back' };
    let chosenRoute: Candidate | null = null;
    let fallbackRoute: Candidate | null = null;

    // ORS round_trip.length is a request, not a guarantee. Give the loop one
    // adjusted attempt, then use a measured out-and-back path if needed.
    for (let attempt = 0; attempt < 2; attempt += 1) {
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
            options: { round_trip: { length: Math.round(requestedLoopMeters), points: 3, seed: randomSeed } },
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
      const feature = providerResult.features?.[0];
      const rawCoordinates = feature?.geometry?.coordinates;
      if (!validCoordinates(rawCoordinates)) return jsonResponse({ error: 'route_provider_missing_elevation' }, 502);

      const stats = buildElevationProfile(rawCoordinates);
      const providerDistance = feature?.properties?.summary?.distance;
      const distanceMeters = typeof providerDistance === 'number' && Number.isFinite(providerDistance) && providerDistance > 0
        ? providerDistance : stats.distanceMeters;
      const providerAscent = feature?.properties?.ascent;
      const ascentMeters = typeof providerAscent === 'number' && Number.isFinite(providerAscent) && providerAscent >= 0
        ? providerAscent : stats.calculatedAscent;
      const fullDistanceMeters = Math.round(distanceMeters * (isDoubleLoop ? 2 : 1));
      if (routeDistanceIsFair(fullDistanceMeters, targetMeters, otherFairDistanceMeters)) {
        chosenRoute = { coordinates: rawCoordinates, stats, distanceMeters, ascentMeters, shape: 'loop' };
        break;
      }
      if (!fallbackRoute) {
        const outAndBack = buildOutAndBack(rawCoordinates, loopTargetMeters);
        if (outAndBack) {
          const fallbackStats = buildElevationProfile(outAndBack);
          const fallbackFullMeters = Math.round(fallbackStats.distanceMeters * (isDoubleLoop ? 2 : 1));
          if (routeDistanceIsFair(fallbackFullMeters, targetMeters, otherFairDistanceMeters)) {
            fallbackRoute = {
              coordinates: outAndBack,
              stats: fallbackStats,
              distanceMeters: fallbackStats.distanceMeters,
              ascentMeters: fallbackStats.calculatedAscent,
              shape: 'out_and_back',
            };
          }
        }
      }
      requestedLoopMeters = Math.max(loopTargetMeters * 0.5, Math.min(loopTargetMeters * 1.5, 5900,
        requestedLoopMeters * desiredMeters / fullDistanceMeters));
    }
    chosenRoute ??= fallbackRoute;
    if (!chosenRoute) return jsonResponse({ error: 'route_distance_unavailable' }, 422);

    const { coordinates: rawCoordinates, stats: baseStats, distanceMeters: baseDistanceMeters, ascentMeters: baseAscentMeters, shape: routeShape } = chosenRoute;
    const fullCoordinates = isDoubleLoop
      ? [...rawCoordinates, ...rawCoordinates.slice(1)]
      : rawCoordinates;
    const fullDistanceMeters = Math.round(baseDistanceMeters * (isDoubleLoop ? 2 : 1));
    const fullAscentMeters = Math.round(baseAscentMeters * (isDoubleLoop ? 2 : 1) * 100) / 100;
    const fullElevationProfile = isDoubleLoop
      ? [...baseStats.profile, ...baseStats.profile.slice(1).map((point) => ({ ...point, distanceMeters: point.distanceMeters + Math.round(baseDistanceMeters) }))]
      : baseStats.profile;

    const { error: updateError } = await client
      .from('race_participants')
      .update({
        route_coordinates: fullCoordinates,
        route_elevation_profile: fullElevationProfile,
        route_distance_m: fullDistanceMeters,
        route_shape: routeShape,
        elevation_gain_m: fullAscentMeters,
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
      distanceMeters: fullDistanceMeters,
      routeShape,
      elevationGainMeters: fullAscentMeters,
      loopRepeats: isDoubleLoop ? 2 : 1,
      coordinates: fullCoordinates,
      elevationProfile: fullElevationProfile,
    });
  },
};
