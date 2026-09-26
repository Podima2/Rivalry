import { ProfileServiceError } from '@/lib/profileService';
import type { RoutePreview } from '@/lib/routeService';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export type RaceProgressSnapshot = {
  raceId: string;
  mode: 'friends' | 'strangers';
  receivedAt: number;
  status: 'active' | 'completed';
  distanceKm: number;
  startedAt: string | null;
  serverTime: string | null;
  ownRoute: [number, number, number][];
  participants: {
    handle: string;
    isSelf: boolean;
    state: 'running' | 'finished' | 'dnf';
    progressMeters: number;
    routeDistanceMeters: number;
    offRouteCount: number;
    offRouteMs: number;
    gpsGapMs: number;
    longestGpsGapMs: number;
    dnfReason: 'quit' | 'inactive' | 'time_limit' | null;
    resultValid: boolean | null;
    elapsedMs: number | null;
    outcome: 'win' | 'loss' | 'draw' | 'dnf' | 'invalid' | null;
    latestLocation: { latitude: number; longitude: number; accuracy_m: number; captured_at: string; on_route: boolean } | null;
  }[];
};

async function request(accessToken: string, payload: Record<string, unknown>) {
  if (!supabaseUrl || !publishableKey) throw new ProfileServiceError('Race progress is not configured.', 'not_configured', 503);
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/race-progress`, {
      method: 'POST',
      headers: { apikey: publishableKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new ProfileServiceError('Could not reach race progress.', 'network_error', 0);
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new ProfileServiceError('Race progress request failed.', typeof body.error === 'string' ? body.error : 'request_failed', response.status);
  }
  return body;
}

export async function getRaceProgress(accessToken: string, raceId: string): Promise<RaceProgressSnapshot> {
  const body = await request(accessToken, { action: 'snapshot', raceId });
  if (body.raceId !== raceId || !Array.isArray(body.ownRoute) || !Array.isArray(body.participants)) {
    throw new ProfileServiceError('Race progress returned an invalid response.', 'invalid_response', 502);
  }
  return { ...body, receivedAt: Date.now() } as RaceProgressSnapshot;
}

export async function sendRaceLocation(accessToken: string, raceId: string, latitude: number, longitude: number, accuracy: number) {
  const body = await request(accessToken, { action: 'location', raceId, latitude, longitude, accuracy });
  return {
    state: typeof body.state === 'string' ? body.state : 'running',
    onRoute: body.onRoute === true,
    waitingForStart: body.waitingForStart === true,
    distanceFromRouteMeters: typeof body.distanceFromRouteMeters === 'number' ? body.distanceFromRouteMeters : null,
    distanceFromStartMeters: typeof body.distanceFromStartMeters === 'number' ? body.distanceFromStartMeters : null,
  };
}

/** This runner's own saved route for the race, or null if none is generated yet. */
export async function getOwnRoute(accessToken: string, raceId: string): Promise<(RoutePreview & { accepted: boolean }) | null> {
  try {
    const body = await request(accessToken, { action: 'route', raceId });
    if (body.raceId !== raceId || !Array.isArray(body.coordinates)) return null;
    return body as RoutePreview & { accepted: boolean };
  } catch (cause) {
    if (cause instanceof ProfileServiceError && cause.code === 'route_missing') return null;
    throw cause;
  }
}

export async function dismissRaceResult(accessToken: string, raceId: string) {
  return request(accessToken, { action: 'dismiss', raceId });
}

export async function forfeitRace(accessToken: string, raceId: string) {
  return request(accessToken, { action: 'dnf', raceId });
}
