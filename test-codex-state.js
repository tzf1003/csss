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

assert.equal(options.policy, "");
const routedProbe = {};
assert.equal(state.applyProbeRoute(routedProbe, {policy: "fallback"}, {
  read: () => "socks5, proxy.example, 1080, user, pass"
}), "SOCKS5");
assert.deepEqual(routedProbe, {"policy-descriptor": "socks5, proxy.example, 1080, user, pass, underlying-proxy=DIRECT"});
const chainedProbe = {};
state.applyProbeRoute(chainedProbe, {}, {
  read: () => "socks5, proxy.example, 1080, user, pass, underlying-proxy=Entry"
});
assert.deepEqual(chainedProbe, {"policy-descriptor": "socks5, proxy.example, 1080, user, pass, underlying-proxy=Entry"});
const namedProbe = {};
assert.equal(state.applyProbeRoute(namedProbe, {}, {read: () => "CSSS-Probe-SOCKS"}), "policy");
assert.deepEqual(namedProbe, {policy: "CSSS-Probe-SOCKS"});
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

const entry = state.makeEntry(state.acceptState(valid, options, now), options, now);
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
assert.equal(state.modelFromHeaders({"x-codex-routing-hint": "model=gpt-6-astra"}), "gpt-6-astra");
assert.equal(state.handlesModel({"x-codex-routing-hint": "model=gpt-6-astra"}, options), true);
assert.equal(state.handlesModel({"x-codex-routing-hint": "model=gpt-daybreak-blue-latest"}, options), false);
assert.equal(state.streamCompleted("event: response.completed\ndata: {}"), true);
assert.equal(state.streamCompleted("event: response.failed"), false);

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
  lastProbe: {at: now, status: 200, stateLength: 312, accepted: false}
}, options, now);
assert.equal(activePanel.title, "Codex 292：正在复用");
assert.equal(activePanel.style, "good");
assert.match(activePanel.content, /现在发送：会注入 292/);
assert.match(activePanel.content, /续期：上次未通过，1 分 30 秒后重试/);
assert.match(activePanel.content, /最近续期：HTTP 200／state 312 未通过；继续复用缓存 292/);
assert.match(activePanel.content, /已注入 292.*响应 312/);

console.log("codex-state self-check passed");
