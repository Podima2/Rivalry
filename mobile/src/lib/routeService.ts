import { ProfileServiceError } from '@/lib/profileService';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export type RoutePreview = {
  raceId: string;
  targetDistanceKm: 1 | 3 | 5 | 10;
  distanceMeters: number;
  routeShape: 'loop' | 'out_and_back';
  elevationGainMeters: number;
  loopRepeats: 1 | 2;
  coordinates: [number, number, number][];
  elevationProfile: { distanceMeters: number; elevationMeters: number }[];
};

export async function createRoutePreview(
  accessToken: string,
  raceId: string,
  latitude: number,
  longitude: number,
  forceRefresh = false,
): Promise<RoutePreview> {
  if (!supabaseUrl || !publishableKey) {
    throw new ProfileServiceError('Route service is not configured.', 'not_configured', 503);
  }

  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/route-preview`, {
      method: 'POST',
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raceId, latitude, longitude, forceRefresh }),
    });
  } catch {
    throw new ProfileServiceError('Could not reach Rivalry’s route service.', 'network_error', 0);
  }

  let body: Partial<RoutePreview> & { error?: string } = {};
  try {
    body = await response.json();
  } catch {
    // The status below still maps the request to an error.
  }
  if (!response.ok) {
    throw new ProfileServiceError('Route request was not accepted.', body.error ?? 'request_failed', response.status);
  }
  if (!body.raceId || !Array.isArray(body.coordinates) || !Array.isArray(body.elevationProfile)) {
    throw new ProfileServiceError('Route service returned an invalid route.', 'invalid_response', 502);
  }
  return body as RoutePreview;
}
