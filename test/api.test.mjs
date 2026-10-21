// Runs against the real API with a test key: SIGNOPS_KEY=sk_test_... npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { SignOps, SignOpsError } from "../dist/esm/index.js";
import cjs from "../dist/cjs/index.cjs";

const key = process.env.SIGNOPS_KEY;
const signops = new SignOps(key, { baseUrl: process.env.SIGNOPS_BASE });

test("CommonJS build exports the same client", () => { assert.equal(typeof cjs.SignOps, "function"); });
test("refuses a publishable key on the server", () => { assert.throws(() => new SignOps("pk_test_x"), /publishable/); });

test("devices, topics and a push", { skip: !key }, async () => {
  const d = await signops.devices.add({ user_id: "usr_node", token: "node-test-token-" + Date.now(), platform: "android", name: "Node test" });
  assert.match(d.id, /^dev_/);
  assert.equal((await signops.devices.list("usr_node")).length >= 1, true);
  await signops.topics.subscribe("node-test", { user_id: "usr_node" });
  const p = await signops.push.send({ topic: "node-test", title: "From @signops/node", body: "Test" });
  assert.match(p.id, /^msg_/);
  const later = await signops.push.send({ user_id: "usr_node", title: "Later", body: "x", send_at: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(later.status, "scheduled");
  assert.equal((await signops.push.cancel(later.id)).status, "cancelled");
  assert.equal((await signops.devices.remove(d.id)).removed, true);
});

test("templates", { skip: !key }, async () => {
  const t = await signops.templates.save({ name: "node_paid", title: "Rs {{amount}} received", body: "Thanks {{name|there}}" });
  assert.deepEqual(t.fields.map((f) => f.name), ["amount", "name"]);
  await signops.devices.add({ user_id: "usr_node_t", token: "node-tpl-" + Date.now(), platform: "android" });
  const p = await signops.push.send({ user_id: "usr_node_t", template: "node_paid", fields: { amount: 499 } });
  assert.equal(p.template, "node_paid");
  await assert.rejects(signops.push.send({ user_id: "usr_node_t", template: "node_paid" }), (e) => e.code === "invalid_request" && /amount/.test(e.message));
  assert.equal((await signops.templates.list()).some((x) => x.name === "node_paid"), true);
  await signops.templates.remove("node_paid");
});

test("errors carry the documented code", { skip: !key }, async () => {
  await assert.rejects(signops.push.send({ title: "no target" }), (e) => e instanceof SignOpsError && e.status === 400 && e.code === "invalid_request");
  await assert.rejects(signops.approve.create({ user_id: "usr_nobody", context: "x" }), (e) => e.code === "not_found");
  await assert.rejects(signops.otp.send({ email: "a@example.in" }), (e) => e.code === "not_allowed");
  assert.match((await signops.approve.enrollToken({ user_id: "usr_node" })).token, /^enr_/);
});

test("webhooks.verify accepts a good signature and refuses a bad one", () => {
  const s = new SignOps("sk_test_x", { webhookSecret: "whsec_test" });
  const body = JSON.stringify({ id: "evt_1", type: "push.sent", created: new Date().toISOString(), livemode: false, data: {} });
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex")}`;
  assert.equal(s.webhooks.verify(body, header).type, "push.sent");
  assert.equal(s.webhooks.verify(Buffer.from(body), header).id, "evt_1");
  assert.throws(() => s.webhooks.verify(body + " ", header), /does not match/);
  assert.throws(() => s.webhooks.verify(body, `t=${t - 600},v1=00`), /older than 5 minutes/);
});
