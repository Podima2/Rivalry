import { ProfileServiceError } from '@/lib/profileService';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

type RaceApiResponse = {
  raceId?: unknown;
  inviteCode?: unknown;
  distanceKm?: unknown;
  status?: unknown;
  participants?: unknown;
  scheduledStartAt?: unknown;
  startedAt?: unknown;
  serverTime?: unknown;
  error?: unknown;
};

async function requestFriendRace(accessToken: string, payload: Record<string, unknown>) {
  if (!supabaseUrl || !publishableKey) {
    throw new ProfileServiceError('Race service is not configured.', 'not_configured', 503);
  }

  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/friend-races`, {
      method: 'POST',
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new ProfileServiceError('Could not reach Rivalry’s race service.', 'network_error', 0);
  }

  let body: RaceApiResponse = {};
  try {
    body = await response.json();
  } catch {
    // A non-JSON error still maps to a general request failure below.
  }

  if (!response.ok) {
    throw new ProfileServiceError('Race request was not accepted.', typeof body.error === 'string' ? body.error : 'request_failed', response.status);
  }
  return body;
}

export async function createFriendInvite(accessToken: string, distanceKm: 1 | 3 | 5 | 10) {
  const result = await requestFriendRace(accessToken, { action: 'create', distanceKm });
  if (typeof result.raceId !== 'string' || typeof result.inviteCode !== 'string' || result.distanceKm !== distanceKm) {
    throw new ProfileServiceError('Race service returned an invalid invite.', 'invalid_response', 502);
  }
  return { raceId: result.raceId, inviteCode: result.inviteCode, distanceKm };
}

export async function joinFriendInvite(accessToken: string, inviteCode: string) {
  const result = await requestFriendRace(accessToken, { action: 'join', inviteCode });
  if (typeof result.raceId !== 'string' || typeof result.distanceKm !== 'number') {
    throw new ProfileServiceError('Race service returned an invalid race.', 'invalid_response', 502);
  }
  return { raceId: result.raceId, distanceKm: result.distanceKm as 1 | 3 | 5 | 10 };
}

export async function getActiveFriendRace(accessToken: string) {
  const result = await requestFriendRace(accessToken, { action: 'active' });
  if (result.raceId === null) return null;
  if (typeof result.raceId !== 'string' || ![1, 3, 5, 10].includes(Number(result.distanceKm))) {
    throw new ProfileServiceError('Race service returned an invalid active race.', 'invalid_response', 502);
  }
  return { raceId: result.raceId, distanceKm: Number(result.distanceKm) as 1 | 3 | 5 | 10 };
}

export type FriendRaceStatus = {
  raceId: string;
  status: 'waiting_for_opponent' | 'route_review' | 'ready' | 'countdown' | 'active' | 'completed' | 'cancelled' | 'other';
  distanceKm: 1 | 3 | 5 | 10;
  scheduledStartAt: string | null;
  startedAt: string | null;
  serverTime: string | null;
  receivedAt: number;
  participants: { handle: string; isSelf: boolean; routeDistanceMeters: number | null; elevationGainMeters: number | null; routeAccepted: boolean; startReady: boolean }[];
};

export async function getFriendRaceStatus(accessToken: string, raceId: string): Promise<FriendRaceStatus> {
  const result = await requestFriendRace(accessToken, { action: 'status', raceId });
  if (typeof result.raceId !== 'string' || ![1, 3, 5, 10].includes(Number(result.distanceKm)) || !Array.isArray(result.participants)) {
    throw new ProfileServiceError('Race service returned an invalid status.', 'invalid_response', 502);
  }
  return {
    raceId: result.raceId,
    status: ['waiting_for_opponent', 'route_review', 'ready', 'countdown', 'active', 'completed', 'cancelled'].includes(String(result.status))
      ? result.status as FriendRaceStatus['status']
      : 'other',
    distanceKm: Number(result.distanceKm) as FriendRaceStatus['distanceKm'],
    scheduledStartAt: typeof result.scheduledStartAt === 'string' ? result.scheduledStartAt : null,
    startedAt: typeof result.startedAt === 'string' ? result.startedAt : null,
    serverTime: typeof result.serverTime === 'string' ? result.serverTime : null,
    receivedAt: Date.now(),
    participants: result.participants.map((value) => {
      const participant = value as Record<string, unknown>;
      return {
        handle: typeof participant.handle === 'string' ? participant.handle : 'runner',
        isSelf: participant.isSelf === true,
        routeDistanceMeters: typeof participant.routeDistanceMeters === 'number' ? participant.routeDistanceMeters : null,
        elevationGainMeters: typeof participant.elevationGainMeters === 'number' ? participant.elevationGainMeters : null,
        routeAccepted: participant.routeAccepted === true,
        startReady: participant.startReady === true,
      };
    }),
  };
}

export async function setFriendStartReady(accessToken: string, raceId: string, ready: boolean) {
  const result = await requestFriendRace(accessToken, { action: 'start_ready', raceId, ready });
  if (typeof result.status !== 'string') {
    throw new ProfileServiceError('Race service returned an invalid start status.', 'invalid_response', 502);
  }
  return result.status;
}

export async function acceptFriendRoute(accessToken: string, raceId: string) {
  const result = await requestFriendRace(accessToken, { action: 'accept_route', raceId });
  if (typeof result.status !== 'string') {
    throw new ProfileServiceError('Race service returned an invalid route status.', 'invalid_response', 502);
  }
  return { status: result.status };
}
