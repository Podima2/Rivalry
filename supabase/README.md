# Rivalry server foundation

This folder contains the initial private Supabase schema plus the `runner-profile` and `friend-races` Edge Functions. Rivalry signs users in with Privy rather than Supabase Auth, so each function verifies the Privy access token before reading or changing data. The caller’s Privy user ID is taken from that verified token; it is never accepted from the request body.

The mobile app can keep using its on-device demo profile until both public Supabase values are set in `mobile/.env`:

```dotenv
EXPO_PUBLIC_SUPABASE_URL=
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
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
npx supabase functions deploy runner-profile
npx supabase functions deploy friend-races
```

The Privy verification key is found in the Privy dashboard for the app. Only the verification key is needed for access-token verification; never put a Privy app secret, Supabase secret key, or service-role key in the mobile app or a committed file.

`runner-profile` has platform JWT verification disabled because the app sends a Privy JWT, not a Supabase Auth JWT. The function verifies that token with Privy’s server SDK itself. Every table has RLS enabled, and direct `anon` and `authenticated` table grants are revoked; access is through server functions only.

The schema keeps profile handles unique globally. Friend invite codes contain 80 bits of cryptographic randomness, are stored as hashes, and expire after 48 hours. SQL RPCs create or join an invite atomically, limit races to two participants, and are executable only by `service_role`. Route details, exact starts, verification outcomes, and GPS samples are private server data. Implement the race finalization function so it writes summary rows and deletes all GPS points for that race in the same transaction. Only race summaries should remain after finalization.

Further Edge Functions will be added for invite creation, stranger matching, route generation, World ID proofs, race state and finalization. Keep provider signing keys and routing credentials in Supabase function secrets. Never store raw selfies, identity documents, or World proofs in Rivalry tables.
