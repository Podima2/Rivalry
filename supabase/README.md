# Rivalry server foundation

This folder contains Rivalry's private Supabase schema plus the `runner-profile`, `friend-races`, `stranger-races`, `route-preview`, `race-progress`, and `world-verification` Edge Functions. Rivalry signs users in with Privy rather than Supabase Auth, so each function verifies the Privy access token before reading or changing data. The caller’s Privy user ID is taken from that verified token; it is never accepted from the request body.

The mobile app can keep using its on-device demo profile until both public Supabase values are set in `mobile/.env`:

```dotenv
EXPO_PUBLIC_SUPABASE_URL=
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=
```

After creating a Supabase project, link the CLI to it and apply the migration:

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

Set these function secrets in Supabase. `SUPABASE_SECRET_KEY` is preferred; `SUPABASE_SERVICE_ROLE_KEY` is also accepted for projects that use the legacy server key.

```sh
npx supabase secrets set PRIVY_APP_ID=YOUR_PRIVY_APP_ID PRIVY_VERIFICATION_KEY='YOUR_PRIVY_VERIFICATION_KEY' SUPABASE_SECRET_KEY='YOUR_SUPABASE_SECRET_KEY'
npx supabase secrets set ORS_API_KEY='YOUR_OPENROUTESERVICE_KEY'
npx supabase functions deploy runner-profile
npx supabase functions deploy friend-races
npx supabase functions deploy stranger-races
npx supabase functions deploy route-preview
npx supabase functions deploy world-verification
npx supabase functions deploy race-progress
```

## World ID Sandbox

Create a World ID app in the Developer Portal and enable its World ID 4 RP. Keep the `app_id`, `rp_id`, and RP signing key. Add these as Supabase Function Secrets; the signing key must never go in the mobile environment:

```sh
npx supabase secrets set WORLD_APP_ID='app_...' WORLD_RP_ID='rp_...' WORLD_SIGNING_KEY='...' WORLD_ID_ENVIRONMENT='sandbox'
```

The Seeker test screen uses the current IDKit Sandbox environment. Request Android tester access in the Developer Portal’s **World ID Sandbox** section, then install the private World ID Sandbox app from its Google Play testing link on the Seeker. Sandbox proofs are simulated; they can advance only Sandbox stranger races and must not be presented as production verification. The preview screen exercises Selfie Check with a fresh user-presence check. A race attempt is accepted only for a stranger race in its verification state; Selfie Check is required at every distance and an Official ID credential at 10 km. The current Sandbox setup cannot issue that credential, so 10 km stranger matching is paused.

`world-verification` signs every request on the server, verifies the complete IDKit response with World, and stores only its outcome and credential type. It does not persist the raw proof, selfie, passport data, or identity attributes. The race moves to its countdown only after every ready participant has completed the required checks.

The Privy verification key is found in the Privy dashboard for the app. Only the verification key is needed for access-token verification; never put a Privy app secret, Supabase secret key, or service-role key in the mobile app or a committed file.

`runner-profile` has platform JWT verification disabled because the app sends a Privy JWT, not a Supabase Auth JWT. The function verifies that token with Privy’s server SDK itself. Every table has RLS enabled, and direct `anon` and `authenticated` table grants are revoked; access is through server functions only.

The schema keeps profile handles unique globally. Friend invite codes are four digits, stored as hashes, expire after 10 minutes, and have a per-account attempt limit. SQL RPCs create or join an invite atomically and limit races to two participants. Stranger matching serializes queues by distance and keeps runners waiting until matched or canceled. Route previews use the hosted ORS foot-walking round-trip API from an Edge Function at `api.heigit.org`; its key stays server-side. If the provider's approximate loop misses the agreed distance, the function builds a measured out-and-back path along its walking route. For 10 km, the function requests a 5 km route and repeats it. Runners can regenerate routes during review; the hosted provider may still return a quota error. Route details, exact starts, verification outcomes, and GPS samples are private server data. The race status response exposes only each participant’s handle, route distance, elevation gain, and route acceptance; it never returns start coordinates or route geometry. Finalization writes summary rows and deletes all GPS points for that race in the same transaction.

Android maps need a Google Maps SDK API key in `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`. Restrict it to the Rivalry Android package and development signing fingerprint; iOS uses Apple Maps. Add it to `mobile/.env` before creating the next Android development build. Adding `expo-location` and `react-native-maps` requires rebuilding the native app binary. The picker requests foreground location only.

`race-progress` accepts foreground GPS fixes for active friend and stranger races and projects them onto each runner's private route. Friends receive each other's latest positions and progress. Strangers receive progress only; the API never returns the opponent's GPS position. It also records a finish or DNF. When both participants are done, the database writes summaries and deletes exact GPS points in one transaction. Background GPS tracking still needs implementation. Keep provider signing keys and routing credentials in Supabase function secrets. Never store raw selfies, identity documents, or World proofs in Rivalry tables.

Race starts are coordinated by `set_friend_race_start_ready`: after both routes are accepted, each runner confirms readiness. The second friend confirmation schedules a single 15-second countdown. The second stranger confirmation moves the match to World verification; verified proofs then schedule the countdown. Status polling advances the race to `active` when its scheduled time passes. The active screen records foreground GPS. A stranger opponent sees route progress but no location.
