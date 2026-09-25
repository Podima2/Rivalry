# Rivalry — Initial Plan

## Decision ownership

This section separates product decisions supplied by the project owner from implementation choices proposed or inferred by the AI during planning.

### User input and user-selected decisions

- **Product goal:** Build a mobile app for simultaneous races between friends across the world and verified strangers. The app should have no crypto interfaces.
- **Activity and fairness:** Outdoor running. Generate routes near each runner and account for elevation when comparing difficulty.
- **Race format:** Head-to-head only for v1, with 1 km, 3 km, 5 km, and 10 km presets.
- **Friend races:** Use a shareable invite link or code. Both runners agree to the race and confirm readiness before a countdown. Friends can see each other’s live map position and progression.
- **Stranger matching:** Match globally on the same agreed distance. Keep runners in the queue until they cancel. After matching, both confirm readiness before verification and the countdown.
- **World verification:** Require a fresh Selfie Check for every stranger race. For races over 6 km (the 10 km preset in v1), also require proof that the runner holds a supported Official ID credential, without revealing their identity. If a runner declines or fails verification, cancel the match and return the other runner to the queue.
- **Route decisions:** Start from GPS, with a map pin the runner can adjust to a safe nearby start. Compare total elevation gain as the main difficulty score and show route and elevation profiles. If route profiles differ, show the difference and require both runners to accept.
- **Tracking and results:** Track GPS only during an active race, including when the app is backgrounded or the phone is locked. If GPS is lost or a runner goes off route, keep the clock running, warn them, allow rejoining, and mark unverifiable results invalid. Fastest verified elapsed time wins. Record a DNF in the summary if a stranger quits after starting.
- **Privacy and retention:** Disclose use of start coordinates for hosted route generation. Hide stranger locations. Delete precise GPS tracks after results are finalized; retain race summaries.
- **Accounts and naming:** Use email login, Privy embedded wallets, and a unique public handle chosen during onboarding that resolves to the wallet through an ENS subdomain.
- **Backend and chain:** Use Supabase/Postgres with server functions and a project-owned `.eth` parent on Sepolia, such as `rivalry.eth`.
- **Budget and milestone:** Use free service tiers. The initial success target is local Expo development builds running on physical iPhone and Android devices, with no app store release. Update free Xcode to 26.4+ before the iPhone build.
- **Demo:** Run two accounts on the owner’s Android and iPhone. Use World’s staging/simulator for selfie checks and a clearly labeled demo-only ID tier if the simulator cannot issue Official ID proofs.

### AI-proposed implementation choices

These are implementation recommendations from the planning phase, rather than independently stated requirements:

- Build a TypeScript Expo app with native IDKit integration for mobile verification flows.
- Use Supabase/Postgres for profiles, handles, invitations, matching, race state, and summaries; use Realtime for race updates, server functions for service coordination, and row-level security for data access.
- Keep World signing keys, provider credentials, and ENS registrar signing secrets on the server. Verify World proofs server-side and retain verification outcomes rather than selfie images or ID documents.
- Give friend invite codes a 48-hour lifetime and create or redeem each code atomically, preventing more than two runners from joining one race.
- Use openrouteservice’s hosted free routing tier. Its foot-route distance cap informed the selected workaround: generate a 5 km loop and run it twice for a 10 km race.
- Provide setup documentation and an example environment file. Keep actual credentials out of source control.
- Test core flows on both physical devices, including route acceptance, verification gates, opponent visibility, GPS loss, DNF handling, and deletion of precise tracks after results finalize.

### AI-derived facts and assumptions

- Given the selected race distances, “over 6 km” means the 10 km preset in v1.
- World’s Official ID credential flow supports eligible NFC passports and national IDs. It can prove selected attributes without disclosing the underlying identity; it does not provide a legal-name-to-selfie match. Supported documents and availability depend on World’s current credential support.
- `rivalry.eth` is a candidate parent name, subject to availability. Parent registration and Sepolia testnet setup remain deployment tasks.
- A demo-only ID verification indicator must be visibly distinguished from a successful production World proof.

## Product and implementation outline

### Onboarding and identity

1. Let the runner sign in with email through Privy.
2. Create an embedded wallet and let the runner claim an available public handle.
3. Assign the handle as a subdomain beneath the project’s Sepolia ENS parent, resolving the subdomain to the embedded wallet. Do not expose wallet management or crypto concepts in the app UI.

### Route and race flow

1. The runner chooses a preset distance and a GPS-derived start pin, adjusting it to a safe nearby location if needed.
2. Generate a nearby route for each runner and compare total elevation gain. Show both routes and elevation profiles; both runners must accept if the profiles differ.
3. For 10 km under the selected free routing tier, use a generated 5 km loop twice.
4. In friend mode, create a shareable invite link/code. In stranger mode, match globally by distance.
5. After both runners confirm readiness, enforce the required verification, then start the countdown.
6. During an active race, track location in the background. Share live map location only with friends; show progression only to stranger opponents.
7. Keep time running through GPS loss or route deviation, warn the runner, allow rejoining, and invalidate results that cannot be verified. Show a DNF if a stranger quits after starting. Delete exact GPS tracks after finalization.

### Stranger verification tiers

- **Every stranger race:** Require a fresh World Selfie Check after both runners are matched and ready, before the countdown.
- **10 km stranger races:** Additionally require a World Official ID credential proof before the countdown. The credential proves possession of a supported government ID credential without revealing the document or legal identity.
- **Demo environment:** Use World staging/simulator for selfie verification. If it cannot issue Official ID proofs, use a conspicuously labeled demo-only ID tier for the two-device demonstration; never represent this demo result as production verification.

### Device and service setup

- Follow the Android build notes in `learningsfortokyo.md`, including explicit Java/Android SDK environment setup where needed.
- Upgrade Xcode to 26.4+ before producing the iOS development build; the notes report that Xcode 26.2 blocked the earlier SDK 57 build.
- Configure Privy, Supabase, World ID, route-provider, and ENS testnet settings through local/server environment configuration. Document required dashboard setup and keep secrets server-side.

## Acceptance scenarios

- Create two email accounts, claim distinct handles, and confirm each Sepolia ENS name resolves to its embedded wallet.
- Complete a friend invite race and verify that both runners accept their route profiles and can see live map positions during the race.
- Complete a stranger race and verify a fresh Selfie Check is required before the countdown; the opponent sees progression but no location.
- Attempt a 10 km stranger race and verify that the Official ID credential tier is also required before the countdown.
- Decline or fail stranger verification and confirm the match is canceled and the other runner returns to the queue.
- Run a two-account demo on the owner’s physical Android and iPhone, clearly distinguishing simulated verification from production proof.
- Simulate GPS loss and route deviation; confirm the clock continues, warnings appear, rejoining is allowed, and unverifiable results are invalid.
- Quit a stranger race after starting and confirm the opponent’s summary shows DNF.
- Finalize a race and confirm precise location samples are deleted while the race summary remains.
- Produce local development builds and launch the app on both physical devices. Exercise the World ID return flow on each platform.

## References

- [World IDKit integration](https://docs.world.org/world-id/idkit/integrate)
- [World Selfie Check](https://docs.world.org/world-id/credentials/11)
- [World ID credential overview](https://support.world.org/hc/en-us/articles/55499979675667-What-are-World-ID-Credentials-and-how-do-I-use-them-in-World-ID-app)
- [ENS subname registrar](https://docs.ens.domains/wrapper/creating-subname-registrar/)
- [openrouteservice restrictions](https://openrouteservice.org/restrictions/)
- [Expo local development builds](https://docs.expo.dev/guides/local-app-development/)
