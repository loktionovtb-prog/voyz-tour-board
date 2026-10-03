# Browser Auth REST contract

Verified against Supabase's official Auth REST specification and Email OTP docs. These endpoints have **not** been exercised against a project in this task.

Every request carries `apikey: <publishable key>` and JSON requests carry `Content-Type: application/json`. An email OTP is a user login code, not an API key. Never write login codes, session bodies, or refresh tokens to logs.

1. **Send a code**: `POST /auth/v1/otp` with `{ "email":"person@example.com", "create_user":true }`. The response does not authenticate the user. `create_user:false` is suitable for invite-only access after the owner account exists. In Email Templates include `{{ .Token }}`; the default template may deliver a clickable magic link instead of showing a code. New signup confirmation template should show the code too.
2. **Verify**: `POST /auth/v1/verify` with `{ "email":"person@example.com", "token":"CODE_FROM_EMAIL", "type":"email" }`. Current official client documentation recommends the `email` verification type for email OTP. Successful body contains `access_token`, `refresh_token`, `expires_in`, `expires_at` where provided, and `user.id`.
3. **Validate stored session**: `GET /auth/v1/user` with `Authorization: Bearer <access_token>`. Do not trust a locally decoded JWT as proof of a session; the server validates it.
4. **Refresh**: `POST /auth/v1/token?grant_type=refresh_token` with `{ "refresh_token":"…" }`. Persist the **new pair** atomically. Serialize concurrent refreshes; refresh tokens rotate. An access token expiry should trigger one refresh/retry, not an endless retry loop.
5. **Sign out this device**: `POST /auth/v1/logout?scope=local` with `Authorization: Bearer <access_token>`. Remove local credentials and stop this user's outbox even if the network request fails. A previously issued access JWT can remain valid until its expiry; revoking refresh is not immediate revocation of every JWT.

For authenticated RPC calls use both `apikey` and the user's JWT in `Authorization`. For anonymous guide links omit `Authorization`. The new publishable key is **not a JWT** and must not be used as a Bearer token.

Handle HTTP 429 by showing a resend countdown. Default resend is normally limited to once per minute. The built-in SMTP service has restrictive sending limits; configure a real SMTP provider for production. Code length and expiration come from project Auth settings rather than hardcoded assumptions.

Direct REST consumers must implement persistent-session isolation, cross-tab refresh coordination, expiration, logout, HTTP errors, and recovery themselves. Using bundled `supabase-js` is an alternative if those are not already covered by the browser client. No server-only credential is necessary for this app's owner and guide RPCs.

Sources: [OTP guide](https://supabase.com/docs/guides/auth/auth-email-passwordless), [verifyOtp](https://supabase.com/docs/reference/javascript/auth-verifyotp), [REST specification](https://github.com/supabase/auth/blob/master/openapi.yaml), [API keys](https://supabase.com/docs/guides/getting-started/api-keys), [rate limits](https://supabase.com/docs/guides/auth/rate-limits).
