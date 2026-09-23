const assert = require("node:assert/strict");
const state = require("./codex-state.js");

function token(blocks, issuedAt) {
  const raw = Buffer.alloc(57 + 16 * blocks);
  raw[0] = 0x80;
  raw.writeBigUInt64BE(BigInt(issuedAt), 1);
  return raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

const now = 1900000000;
const valid = token(10, now);
const rejectedShape = token(11, now);
const options = state.parseOptions("model=gpt-6-astra&ttl=3600&renew=600&cooldown=300");
const allOptions = state.parseOptions("model=*&ttl=3600&renew=600&cooldown=300");

assert.equal(options.policy, "");
assert.equal(state.parseOptions("").model, "*");
assert.equal(options.retryBase, 2);
assert.equal(options.retryMax, 60);
const routedProbe = {};
assert.equal(state.applyProbeRoute(routedProbe, {policy: "fallback"}, {
  read: () => "socks5, proxy.example, 1080, user, pass"
}), "SOCKS5");
assert.match(routedProbe["policy-descriptor"], /^CSSS-[A-Za-z0-9]+ = socks5, proxy\.example, 1080, user, pass, underlying-proxy=DIRECT$/);
const chainedProbe = {};
state.applyProbeRoute(chainedProbe, {}, {
  read: () => "socks5, proxy.example, 1080, user, pass, underlying-proxy=Entry"
});
assert.match(chainedProbe["policy-descriptor"], /^CSSS-[A-Za-z0-9]+ = socks5, proxy\.example, 1080, user, pass, underlying-proxy=Entry$/);
assert.equal(
  state.freshProbeDescriptor("socks5, us.1024proxy.io, 3000, user-region-US-sid-old-t-5, pass, underlying-proxy=Entry", "abc-123"),
  "CSSS-abc123 = socks5, us.1024proxy.io, 3000, user-region-US-sid-CSSSabc123-t-1, pass, underlying-proxy=Entry"
);
const namedProbe = {};
assert.equal(state.applyProbeRoute(namedProbe, {}, {read: () => "CSSS-Probe-SOCKS"}), "policy");
assert.deepEqual(namedProbe, {policy: "CSSS-Probe-SOCKS"});
const routeStore = {
  values: {"csss-probe-policy-descriptor-v1": "Probe-01|Probe-02"},
  read(key) { return this.values[key]; },
  write(value, key) { this.values[key] = value; }
};
const firstRotatingProbe = {};
const secondRotatingProbe = {};
state.applyProbeRoute(firstRotatingProbe, {}, routeStore);
state.applyProbeRoute(secondRotatingProbe, {}, routeStore);
assert.deepEqual(firstRotatingProbe, {policy: "Probe-01"});
assert.deepEqual(secondRotatingProbe, {policy: "Probe-02"});
const fallbackProbe = {};
assert.equal(state.applyProbeRoute(fallbackProbe, {policy: "fallback"}, {read: () => ""}), "policy");
assert.deepEqual(fallbackProbe, {policy: "fallback"});
assert.equal(valid.length, 292);
assert.equal(rejectedShape.length, 312);
assert.equal(state.parseState(valid).blocks, 10);
assert.equal(state.parseState(valid).issuedAt, now);
assert.equal(state.acceptState(valid, options, now).blocks, 10);
assert.equal(state.acceptState(rejectedShape, options, now), undefined);
assert.equal(state.acceptState(token(10, now - 3600), options, now), undefined);
assert.equal(state.parseState("not-a-state"), undefined);

const entry = state.makeEntry(state.acceptState(valid, options, now), options, now, "gpt-6-astra");
assert.equal(entry.refreshAt, now + 3000);
assert.equal(entry.expiresAt, now + 3570);
assert.equal(state.shouldRenew(entry, now + 2999), false);
assert.equal(state.shouldRenew(entry, now + 3000), true);
entry.strikes = 2;
assert.equal(state.shouldRenew(entry, now + 2999), false);
assert.equal(state.usable(entry, now + 3569), true);
assert.equal(state.usable(entry, now + 3570), false);

assert.equal(state.getHeader({Authorization: "token"}, "authorization"), "token");
assert.deepEqual(
  state.setHeader({"X-Codex-Turn-State": "old", Keep: "yes"}, "x-codex-turn-state", "new"),
  {Keep: "yes", "x-codex-turn-state": "new"}
);
assert.equal(state.extractState({"X-Codex-Turn-State": valid}), valid);
assert.equal(state.entryKey({"chatgpt-account-id": "fixture-account"}, options), "fixture-account\u0000gpt-6-astra");
assert.equal(state.entryKey({"chatgpt-account-id": "fixture-account"}, allOptions, "gpt-6-sol"), "fixture-account\u0000gpt-6-sol");
assert.equal(state.modelFromHeaders({"x-codex-routing-hint": "model=gpt-6-astra"}), "gpt-6-astra");
assert.equal(state.modelFromBody('{"model":"gpt-6-sol"}'), "gpt-6-sol");
assert.equal(state.requestModel({}, '{"model":"gpt-daybreak-blue-latest"}', allOptions), "gpt-daybreak-blue-latest");
assert.equal(state.handlesModel({"x-codex-routing-hint": "model=gpt-6-astra"}, options), true);
assert.equal(state.handlesModel({"x-codex-routing-hint": "model=gpt-daybreak-blue-latest"}, options), false);
assert.equal(state.handlesModel({}, allOptions, '{"model":"gpt-6-sol"}'), true);
assert.equal(state.handlesModel({}, allOptions, ""), false);
assert.deepEqual(JSON.parse(state.probeBody("gpt-6-sol")), {
  model: "gpt-6-sol",
  input: "Reply with OK.",
  stream: true,
  store: false
});
assert.equal(state.streamCompleted("event: response.completed\ndata: {}"), true);
assert.equal(state.streamCompleted("event: response.failed"), false);
assert.equal(state.probeRetryDelay(200, {blocks: 11}, {}, options), 30);
assert.equal(state.probeRetryDelay(429, undefined, {"Retry-After": "600"}, options), 600);
assert.equal(state.probeRetryDelay(403, undefined, {}, options), 3600);
assert.equal(state.probeRetryDelay(0, undefined, {}, options), 30);
assert.equal(state.retryAfterSeconds({"Retry-After": "12"}, now), 12);
assert.equal(state.retryAfterSeconds({"Retry-After": new Date((now + 15) * 1000).toUTCString()}, now), 15);
const rateStore = {rateLimits: {}};
const rateHeaders = {"chatgpt-account-id": "fixture-account"};
assert.deepEqual(state.markRateLimit(rateStore, rateHeaders, {}, options, now), {delay: 2, failures: 1, retryAfter: 2});
assert.equal(state.backoffWait(rateStore, rateHeaders, now), 2);
assert.deepEqual(state.markRateLimit(rateStore, rateHeaders, {"retry-after": "10"}, options, now + 2), {delay: 10, failures: 2, retryAfter: 10});
assert.equal(state.backoffWait(rateStore, rateHeaders, now + 2), 10);
assert.equal(state.accountProbeActive({entries: {
  ["fixture-account\u0000gpt-6-astra"]: {probeUntil: now + 20}
}}, rateHeaders, "fixture-account\u0000gpt-6-sol", now), true);
assert.equal(state.accountProbeActive({entries: {
  ["other-account\u0000gpt-6-astra"]: {probeUntil: now + 20}
}}, rateHeaders, "fixture-account\u0000gpt-6-sol", now), false);

const context = state.requestContext({
  "thread-id": "00000000-0000-0000-0000-12345678abcd",
  "x-codex-turn-metadata": JSON.stringify({turn_id: "00000000-0000-0000-0000-abcdef123456"})
});
assert.deepEqual(context, {thread: "5678abcd", turn: "ef123456"});

const waitingPanel = state.panelView({entries: {}, history: [], lastProbe: null}, options, now);
assert.equal(waitingPanel.title, "Codex 292：等待采集");
assert.match(waitingPanel.content, /现在发送：先采集/);

entry.injectionCount = 3;
entry.refreshAt = now - 1;
entry.nextProbeAt = now + 90;
const activePanel = state.panelView({
  entries: {test: entry},
  history: [{id: "request", type: "request", at: now, injected: true, thread: "5678abcd", responseLength: 312}],
  rateLimits: {test: {until: now + 10, failures: 2}},
  lastProbe: {at: now, status: 200, stateLength: 312, accepted: false}
}, options, now);
assert.equal(activePanel.title, "Codex 292：正在复用");
assert.equal(activePanel.style, "good");
assert.match(activePanel.content, /现在发送：会注入 292/);
assert.match(activePanel.content, /模型：gpt-6-astra/);
assert.match(activePanel.content, /续期：上次未通过，1 分 30 秒后重试/);
assert.match(activePanel.content, /最近续期：HTTP 200／state 312 未通过；继续复用缓存 292/);
assert.match(activePanel.content, /429 退避：10 秒／连续 2 次/);
assert.match(activePanel.content, /已注入 292.*响应 312/);

console.log("codex-state self-check passed");
