# @signops/node

SignOps for Node.js: push notifications to Android, iOS and the web, push approval of logins, passkeys and webhooks, on one API key and your own user ids. Website: https://signops.dev. Docs: https://signops.dev/docs/

```sh
npm install @signops/node
```

```js
import { SignOps } from "@signops/node"; // or: const { SignOps } = require("@signops/node");

const signops = new SignOps(process.env.SIGNOPS_KEY); // sk_live_... or sk_test_...

// Your server registers the token your app got from FCM, APNs or the browser.
await signops.devices.add({ user_id: "usr_8f21c4", token: fcmToken, platform: "android" });

// Every device of this user.
await signops.push.send({ user_id: "usr_8f21c4", title: "Your order is out for delivery", body: "Ravi is 10 minutes away." });

// A topic, later.
await signops.push.send({ topic: "offers", title: "Weekend offer", body: "20% off fruit", send_at: "2026-10-24T18:00:00+05:30" });

// Ask the user's trusted phone, show challenge.match on your login page, then wait.
const challenge = await signops.approve.create({ user_id: "usr_8f21c4", context: "Sign in from Chrome on Windows" });
const result = await signops.approve.wait(challenge.id, { timeout: 120 });
if (result.status === "approved") startSession(result.user_id);

// Passkeys: a token for the browser, then confirm the sign-in.
const { token } = await signops.passkeys.registrationToken({ user_id: "usr_8f21c4" });
const check = await signops.passkeys.verify(req.body.signops_token);

// Webhooks: pass the raw body.
const event = signops.webhooks.verify(req.body, req.headers["signops-signature"]); // SIGNOPS_WEBHOOK_SECRET
```

Errors throw `SignOpsError` with `status`, `code` (`invalid_request`, `invalid_key`, `not_allowed`, `not_found`, `already_done`, `expired`, `rate_limited`, `server_error`) and a message. Every POST carries an `Idempotency-Key`, so the built-in retries on network errors, 429 and 5xx never send twice. No dependencies; Node 18 or later.
