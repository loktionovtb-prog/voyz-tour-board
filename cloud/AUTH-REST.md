# Browser Auth REST contract

Verified against Supabase's official Auth REST specification and Email OTP docs. Delivery of a real Auth email and owner sign-in using its magic link succeeded in the published app. Manual OTP verification, refresh-token rotation, real-session logout and two simultaneously signed-in devices have **not** been exercised. The anonymous route RPC was separately verified against the real Supabase project.

Every request carries `apikey: <publishable key>` and JSON requests carry `Content-Type: application/json`. An email OTP is a user login code, not an API key. Never write login codes, session bodies, or refresh tokens to logs.

1. **Send a login email**: `POST /auth/v1/otp` with `{ "email":"person@example.com", "create_user":true }`. The response does not authenticate the user. `create_user:false` is suitable for invite-only access after the owner account exists. The current application passes an allowed redirect URL via the SDK and accepts the default magic link, with `detectSessionInUrl:true`. For custom SMTP templates, include `{{ .Token }}` to support manual code entry; new Free projects using Supabase's default SMTP cannot customize templates as of 2026-06-03. Open a magic link on the same device where you want to work, and allow the published GitHub Pages URL in Auth redirect settings.
2. **Verify**: `POST /auth/v1/verify` with `{ "email":"person@example.com", "token":"CODE_FROM_EMAIL", "type":"email" }`. Current official client documentation recommends the `email` verification type for email OTP. Successful body contains `access_token`, `refresh_token`, `expires_in`, `expires_at` where provided, and `user.id`.
3. **Validate stored session**: `GET /auth/v1/user` with `Authorization: Bearer <access_token>`. Do not trust a locally decoded JWT as proof of a session; the server validates it.
4. **Refresh**: `POST /auth/v1/token?grant_type=refresh_token` with `{ "refresh_token":"…" }`. Persist the **new pair** atomically. Serialize concurrent refreshes; refresh tokens rotate. An access token expiry should trigger one refresh/retry, not an endless retry loop.
5. **Sign out this device**: `POST /auth/v1/logout?scope=local` with `Authorization: Bearer <access_token>`. Remove local credentials and stop this user's outbox even if the network request fails. A previously issued access JWT can remain valid until its expiry; revoking refresh is not immediate revocation of every JWT.

For authenticated RPC calls use both `apikey` and the user's JWT in `Authorization`. For anonymous guide links omit `Authorization`. The new publishable key is **not a JWT** and must not be used as a Bearer token.

Handle HTTP 429 by showing a resend countdown. Default resend is normally limited to once per minute. The built-in SMTP service has restrictive sending limits; configure a real SMTP provider for production. Code length and expiration come from project Auth settings rather than hardcoded assumptions.

Direct REST consumers must implement persistent-session isolation, cross-tab refresh coordination, expiration, logout, HTTP errors, and recovery themselves. Using bundled `supabase-js` is an alternative if those are not already covered by the browser client. No server-only credential is necessary for this app's owner and guide RPCs.

## Live browser route test (2026-10-03)

The published app successfully called anonymous `POST /rest/v1/rpc/voyz_read_share` against project `mjlpcvqrwbtmabivgxuj`. The route showed lodging, timing and notes without fake CRM fields or editing controls. An owner CAS update through SQL RPC changed the description, and refreshing the same browser link displayed that exact update. Owner RPC revocation persisted; the subsequent browser request displayed the revoked-access message and removed the route card. The isolated fake account, tour and share were then deleted, and a post-commit query confirmed no fixture rows remained. No real user data, passwords, session credentials or real email recipients were involved.

This verifies the anonymous REST route and live update/revocation path. The fixture test did not use a real Auth session.

## Real owner sign-in and import (2026-10-03)

The owner opened a real magic link from an Auth email and signed in on the published GitHub Pages app. Through the app UI, the existing local library was imported into the project/account namespace and uploaded. A separate read-only database check confirmed exactly one active May tour at revision 1. All 230 JSON nodes matched the original backup, ignoring only the intentionally new imported-tour ID and view preferences; all seven photo leaf SHA-256 hashes matched. CRM, pricing, timing, notes, lodging, card layout and connections were preserved. Verification did not modify the owner's route.

This confirms the actual email magic-link login, browser owner session and first route upload. It does **not** confirm manual-code verification, refresh-token rotation, real-session logout, a physical phone/tablet or synchronization between two authenticated devices. No passwords, magic-link URLs or session credentials were written into QA reports.

Sources: [OTP guide](https://supabase.com/docs/guides/auth/auth-email-passwordless), [verifyOtp](https://supabase.com/docs/reference/javascript/auth-verifyotp), [REST specification](https://github.com/supabase/auth/blob/master/openapi.yaml), [API keys](https://supabase.com/docs/guides/getting-started/api-keys), [rate limits](https://supabase.com/docs/guides/auth/rate-limits), [Free email template restriction](https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier).
