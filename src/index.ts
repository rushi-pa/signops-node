// SignOps for Node.js. Docs: https://signops.dev/docs/
//
//   import { SignOps } from "@signops/node";
//   const signops = new SignOps(process.env.SIGNOPS_KEY);
//   await signops.push.send({ user_id: "usr_8f21c4", title: "Your order is out for delivery", body: "Ravi is 10 minutes away." });
//
// No dependencies: it uses the fetch and crypto that Node 18 and later have built in.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type Platform = "android" | "ios" | "web";
export type Json = Record<string, unknown>;

export interface Options {
  /** Defaults to https://api.signops.dev */
  baseUrl?: string;
  /** Your webhook endpoint's signing secret, for webhooks.verify. Defaults to SIGNOPS_WEBHOOK_SECRET. */
  webhookSecret?: string;
  /** Per request, in milliseconds. Default 30,000 (approve.wait asks for longer on its own). */
  timeoutMs?: number;
  /** Retries for network errors, 429 and 5xx. Every POST carries an Idempotency-Key, so a retry never sends twice. Default 2. */
  maxRetries?: number;
}

export class SignOpsError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "SignOpsError";
  }
}

export interface PushInput {
  user_id?: string; user_ids?: string[]; topic?: string; all?: true;
  title?: string; body?: string; image?: string; link?: string; data?: Record<string, unknown>;
  /** An ISO time with a zone, up to 30 days ahead, like 2026-10-24T18:00:00+05:30. */
  send_at?: string; collapse_key?: string;
  /** A template's name, filled with fields. Anything given here (title, body...) wins over the template's text. */
  template?: string; fields?: Record<string, string | number>;
  /** With user_ids: each user's own fields, on top of fields. */
  fields_by_user?: Record<string, Record<string, string | number>>;
}
export interface Template { name: string; description?: string | null; title?: string | null; body?: string | null; image?: string | null; link?: string | null; data?: Record<string, string> | null; fields?: { name: string; fallback: string | null }[] }
export interface PushMessage { id: string; status: "scheduled" | "sending" | "sent" | "cancelled" | "failed"; send_at: string | null; devices?: number; sent?: number; failed?: number; by_platform?: Record<Platform, { sent: number; failed: number }> }
export interface Device { id: string; user_id: string; platform: Platform; route?: string; name?: string | null; trusted?: boolean; created_at?: string; last_seen_at?: string }
export interface Approval { id: string; user_id: string; status: "pending" | "approved" | "denied" | "expired" | "cancelled"; match?: string; context?: string; device_id?: string | null; expires_at: string; answered_at?: string | null; reason?: string }
export interface WebhookEvent<T = Json> { id: string; type: string; created: string; livemode: boolean; data: T }
type Req = { idempotencyKey?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SignOps {
  private key: string;
  private base: string;
  private timeout: number;
  private retries: number;
  private hookSecret?: string;

  readonly push: Push;
  readonly devices: Devices;
  readonly topics: Topics;
  readonly templates: Templates;
  readonly approve: Approve;
  readonly passkeys: Passkeys;
  readonly otp: Otp;
  readonly webhooks: Webhooks;

  constructor(key: string | undefined = typeof process !== "undefined" ? process.env.SIGNOPS_KEY : undefined, opts: Options = {}) {
    if (!key) throw new Error("SignOps: pass your secret key, or set SIGNOPS_KEY.");
    if (key.startsWith("pk_")) throw new Error("SignOps: this is a publishable key. On your server use the secret key, sk_live_... or sk_test_....");
    this.key = key;
    this.base = (opts.baseUrl ?? "https://api.signops.dev").replace(/\/$/, "");
    this.timeout = opts.timeoutMs ?? 30_000;
    this.retries = opts.maxRetries ?? 2;
    this.hookSecret = opts.webhookSecret ?? (typeof process !== "undefined" ? process.env.SIGNOPS_WEBHOOK_SECRET : undefined);
    this.push = new Push(this);
    this.devices = new Devices(this);
    this.topics = new Topics(this);
    this.templates = new Templates(this);
    this.approve = new Approve(this);
    this.passkeys = new Passkeys(this);
    this.otp = new Otp(this);
    this.webhooks = new Webhooks(() => this.hookSecret);
  }

  /** Any API call: request("POST", "/v1/push", {...}). The typed helpers cover the documented ones. */
  async request<T = Json>(method: "GET" | "POST" | "DELETE", path: string, body?: Json, o: Req & { timeoutMs?: number } = {}): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.key}`, "user-agent": "signops-node/0.1.0" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method === "POST") headers["idempotency-key"] = o.idempotencyKey ?? randomUUID();
    let last: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs ?? this.timeout) });
      } catch (e) {
        last = e;
        if (attempt < this.retries) { await sleep(500 * 2 ** attempt); continue; }
        throw new SignOpsError(0, "network_error", `Could not reach SignOps: ${(e as Error).message}`);
      }
      const j = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
      if (res.ok) return j as T;
      if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
        const wait = Number(res.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt;
        await sleep(Math.min(wait, 10_000));
        continue;
      }
      throw new SignOpsError(res.status, j.error?.code ?? "error", j.error?.message ?? `SignOps answered ${res.status}`);
    }
    throw last;
  }
}

const q = (s: string) => encodeURIComponent(s);

class Push {
  constructor(private s: SignOps) {}
  /** To one of user_id, user_ids (up to 1,000), topic or all. */
  send(p: PushInput, o: Req = {}) { return this.s.request<PushMessage>("POST", "/v1/push", p as Json, o); }
  get(id: string) { return this.s.request<PushMessage>("GET", `/v1/push/${q(id)}`); }
  /** Only a scheduled push can be cancelled. */
  cancel(id: string) { return this.s.request<PushMessage>("DELETE", `/v1/push/${q(id)}`); }
}

class Devices {
  constructor(private s: SignOps) {}
  /** token is the FCM or APNs token, or for web the PushSubscription your page got. */
  add(d: { user_id: string; token: string | Json; platform: Platform; name?: string }) { return this.s.request<Device>("POST", "/v1/devices", d as Json); }
  remove(id: string) { return this.s.request<{ id: string; removed: boolean }>("DELETE", `/v1/devices/${q(id)}`); }
  list(user_id: string) { return this.s.request<{ data: Device[] }>("GET", `/v1/devices?user_id=${q(user_id)}`).then((r) => r.data); }
}

class Topics {
  constructor(private s: SignOps) {}
  subscribe(topic: string, o: { user_id: string }) { return this.s.request("POST", `/v1/topics/${q(topic)}/subscribe`, o); }
  unsubscribe(topic: string, o: { user_id: string }) { return this.s.request("POST", `/v1/topics/${q(topic)}/unsubscribe`, o); }
}

class Templates {
  constructor(private s: SignOps) {}
  list() { return this.s.request<{ data: Template[] }>("GET", "/v1/templates").then((r) => r.data); }
  get(name: string) { return this.s.request<Template>("GET", `/v1/templates/${q(name)}`); }
  /** Creates or replaces a template by name. */
  save(t: Template) { return this.s.request<Template>("POST", "/v1/templates", t as unknown as Json); }
  remove(name: string) { return this.s.request("DELETE", `/v1/templates/${q(name)}`); }
}

class Approve {
  constructor(private s: SignOps) {}
  /** A one-time token your app passes to the SDK to trust this phone for the signed-in user. Good for 10 minutes. */
  enrollToken(o: { user_id: string }) { return this.s.request<{ token: string; expires_at: string }>("POST", "/v1/approve/enroll-token", o); }
  /** Pushes to the user's trusted phones. Show the returned match on your login page. */
  create(o: { user_id: string; context: string; city?: string; browser?: string; ip?: string }, r: Req = {}) { return this.s.request<Approval>("POST", "/v1/approve", o, r); }
  get(id: string) { return this.s.request<Approval>("GET", `/v1/approve/${q(id)}`); }
  /** Waits until the user answers or the request expires, up to timeout seconds (default and most 120). */
  async wait(id: string, o: { timeout?: number } = {}): Promise<Approval> {
    const until = Date.now() + Math.min(o.timeout ?? 120, 120) * 1000;
    for (;;) {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      const a = await this.s.request<Approval>("GET", `/v1/approve/${q(id)}?wait=${Math.min(left, 25)}`, undefined, { timeoutMs: 40_000 });
      if (a.status !== "pending" || Date.now() >= until) return a;
    }
  }
  /** create, then wait. The match is on the result too, but show it before waiting if you can: call create and wait separately. */
  async createAndWait(o: { user_id: string; context: string; city?: string; browser?: string; ip?: string }, w: { timeout?: number } = {}) {
    const a = await this.create(o);
    return { ...(await this.wait(a.id, w)), match: a.match };
  }
  cancel(id: string) { return this.s.request<Approval>("POST", `/v1/approve/${q(id)}/cancel`, {}); }
  /** Stops a phone being trusted. It still gets pushes. */
  untrust(deviceId: string) { return this.s.request("POST", `/v1/approve/devices/${q(deviceId)}/remove`, {}); }
}

class Passkeys {
  constructor(private s: SignOps) {}
  /** For the browser's passkeys.register. rp_id is checked against the domain set in the dashboard. */
  registrationToken(o: { user_id: string; user_name?: string; display_name?: string; rp_id?: string }) {
    return this.s.request<{ token: string; expires_at: string }>("POST", "/v1/passkeys/registration-token", o);
  }
  /** Confirms the signops_token from the browser's passkeys.signIn. Single use. */
  verify(signops_token: string) { return this.s.request<{ valid: boolean; verified: boolean; user_id: string | null; credential_id: string | null }>("POST", "/v1/passkeys/verify", { signops_token }); }
  list(user_id: string) { return this.s.request<{ data: Json[] }>("GET", `/v1/passkeys?user_id=${q(user_id)}`).then((r) => r.data); }
  remove(id: string) { return this.s.request("DELETE", `/v1/passkeys/${q(id)}`); }
}

class Otp {
  constructor(private s: SignOps) {}
  send(o: { email: string; app_name?: string }) { return this.s.request<{ otp_id: string }>("POST", "/v1/otp/send", o); }
  verify(o: { otp_id: string; code: string }) { return this.s.request<{ valid: boolean }>("POST", "/v1/otp/verify", o); }
}

class Webhooks {
  constructor(private secret: () => string | undefined) {}
  /**
   * Checks the SignOps-Signature header against the raw body and returns the event. Throws if it does not match or is
   * more than 5 minutes old. Pass the body exactly as received (a Buffer or string), before any JSON parsing.
   */
  verify<T = Json>(rawBody: string | Uint8Array, header: string | string[] | undefined | null, secret?: string, toleranceSeconds = 300): WebhookEvent<T> {
    const key = secret ?? this.secret();
    if (!key) throw new Error("SignOps: no webhook secret. Pass it, or set SIGNOPS_WEBHOOK_SECRET.");
    const h = Array.isArray(header) ? header[0] : header;
    const parts = Object.fromEntries((h ?? "").split(",").map((p) => p.trim().split("=") as [string, string]));
    const t = Number(parts.t);
    if (!parts.v1 || !Number.isFinite(t)) throw new SignOpsError(400, "invalid_signature", "No SignOps-Signature header, or it is not t=...,v1=...");
    if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) throw new SignOpsError(400, "invalid_signature", "The event is older than 5 minutes.");
    const body = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8");
    const want = Buffer.from(createHmac("sha256", key).update(`${t}.${body}`).digest("hex"));
    const got = Buffer.from(parts.v1);
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new SignOpsError(400, "invalid_signature", "The signature does not match. Check the secret and that the body is the raw one.");
    return JSON.parse(body) as WebhookEvent<T>;
  }
}

export default SignOps;
