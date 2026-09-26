import { ProfileServiceError } from '@/lib/profileService';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export type StrangerRaceStatus = {
  raceId: string;
  status: 'waiting_for_opponent' | 'route_review' | 'ready' | 'verification' | 'countdown' | 'active' | 'completed' | 'cancelled';
  distanceKm: 1 | 3 | 5 | 10;
  scheduledStartAt: string | null;
  startedAt: string | null;
  serverTime: string | null;
  receivedAt: number;
  participants: {
    handle: string;
    isSelf: boolean;
    routeDistanceMeters: number | null;
    elevationGainMeters: number | null;
    routeAccepted: boolean;
    startReady: boolean;
    selfieVerified: boolean;
    officialIdVerified: boolean;
  }[];
};

async function request(accessToken: string, payload: Record<string, unknown>) {
  if (!supabaseUrl || !publishableKey) throw new ProfileServiceError('Stranger races are not configured.', 'not_configured', 503);
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/stranger-races`, {
      method: 'POST',
      headers: { apikey: publishableKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new ProfileServiceError('Could not reach stranger matching.', 'network_error', 0);
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new ProfileServiceError('Stranger race request failed.',
    typeof body.error === 'string' ? body.error : 'request_failed', response.status);
  return body;
}

export async function joinStrangerQueue(accessToken: string, distanceKm: 1 | 3 | 5 | 10) {
  const result = await request(accessToken, { action: 'queue', distanceKm });
  if (typeof result.raceId !== 'string') throw new ProfileServiceError('Invalid queue response.', 'invalid_response', 502);
  return result.raceId;
}

export async function getActiveStrangerRace(accessToken: string) {
  const result = await request(accessToken, { action: 'active' });
  if (result.raceId === null) return null;
  if (typeof result.raceId !== 'string') throw new ProfileServiceError('Invalid queue response.', 'invalid_response', 502);
  return result.raceId;
}

export async function getStrangerRaceStatus(accessToken: string, raceId: string): Promise<StrangerRaceStatus> {
  const result = await request(accessToken, { action: 'status', raceId });
  if (result.raceId !== raceId || !Array.isArray(result.participants) ||
      ![1, 3, 5, 10].includes(Number(result.distanceKm))) {
    throw new ProfileServiceError('Invalid stranger race response.', 'invalid_response', 502);
  }
  return { ...result, receivedAt: Date.now() } as StrangerRaceStatus;
}

export async function acceptStrangerRoute(accessToken: string, raceId: string) {
  return request(accessToken, { action: 'accept_route', raceId });
}

export async function setStrangerStartReady(accessToken: string, raceId: string, ready: boolean) {
  return request(accessToken, { action: 'start_ready', raceId, ready });
}

export async function leaveStrangerRace(accessToken: string, raceId: string) {
  return request(accessToken, { action: 'leave', raceId });
}
