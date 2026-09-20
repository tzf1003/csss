const STORE_KEY = "codex-turn-state-v5";
const PROBE_HEADER = "x-codex-state-probe";
const PROBE_POLICY_KEY = "csss-probe-policy-descriptor-v1";
const PROBE_POLICY_CURSOR_KEY = "csss-probe-policy-cursor-v1";

function getHeader(headers, name) {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
}

function setHeader(headers, name, value) {
  const result = Object.assign({}, headers);
  const wanted = name.toLowerCase();
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === wanted) delete result[key];
  }
  result[name] = value;
  return result;
}

function parseOptions(raw) {
  const result = {
    policy: "",
    model: "gpt-6-astra",
    blocks: 10,
    ttl: 3600,
    renew: 600,
    cooldown: 300,
    probeTimeout: 20,
    forceHttp: true
  };
  for (const part of String(raw || "").split("&")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = decodeURIComponent(part.slice(0, separator));
    const value = decodeURIComponent(part.slice(separator + 1));
    if (key === "policy") result.policy = value;
    if (key === "model" && value) result.model = value;
    if (key === "blocks" && Number(value) > 0) result.blocks = Number(value);
    if (key === "ttl" && Number(value) >= 120) result.ttl = Number(value);
    if (key === "renew" && Number(value) >= 30) result.renew = Number(value);
    if (key === "cooldown" && Number(value) >= 30) result.cooldown = Number(value);
    if (key === "timeout" && Number(value) > 0) result.probeTimeout = Number(value);
    if (key === "force_http") result.forceHttp = value !== "0" && value !== "false";
  }
  if (result.renew >= result.ttl) result.renew = Math.max(30, Math.floor(result.ttl / 3));
  return result;
}

function decodeBase64Url(value) {
  value = String(value || "").trim();
  if (!value || value.length > 2048 || /[\r\n\t ]/.test(value)) return undefined;
  const padding = (value.match(/=+$/) || [""])[0].length;
  if (padding > 2) return undefined;
  const core = value.slice(0, value.length - padding);
  if (!/^[A-Za-z0-9_-]+$/.test(core) || core.length % 4 === 1) return undefined;
  if (padding && (core.length + padding) % 4 !== 0) return undefined;

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of core) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return undefined;
    accumulator = accumulator * 64 + digit;
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      const divisor = Math.pow(2, bits);
      bytes.push(Math.floor(accumulator / divisor) & 255);
      accumulator %= divisor;
    }
  }
  if (accumulator !== 0) return undefined;
  return bytes;
}

function fingerprint(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function parseState(value) {
  value = String(value || "").trim();
  const raw = decodeBase64Url(value);
  if (!raw || raw.length < 73 || raw[0] !== 0x80 || (raw.length - 57) % 16 !== 0) return undefined;

  let high = 0;
  let low = 0;
  for (let index = 1; index < 5; index++) high = high * 256 + raw[index];
  for (let index = 5; index < 9; index++) low = low * 256 + raw[index];
  const issuedAt = high * 4294967296 + low;
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 1577836800 || issuedAt >= 4102444800) return undefined;

  return {
    value,
    issuedAt,
    blocks: (raw.length - 57) / 16,
    fingerprint: fingerprint(value)
  };
}

function acceptState(value, options, now) {
  const token = parseState(value);
  if (!token || token.blocks !== options.blocks) return undefined;
  if (token.issuedAt > now + 30 || now >= token.issuedAt + options.ttl - 30) return undefined;
  return token;
}

function extractState(headers) {
  const value = getHeader(headers, "x-codex-turn-state");
  return value ? String(value) : undefined;
}

function emptyStore() {
  return {entries: {}, flows: {}, history: [], lastProbe: null};
}

function readStore() {
  try {
    const parsed = JSON.parse($persistentStore.read(STORE_KEY) || "{}");
    return {
      entries: parsed && parsed.entries ? parsed.entries : {},
      flows: parsed && parsed.flows ? parsed.flows : {},
      history: parsed && Array.isArray(parsed.history) ? parsed.history : [],
      lastProbe: parsed && parsed.lastProbe ? parsed.lastProbe : null
    };
  } catch (_) {
    return emptyStore();
  }
}

function writeStore(store) {
  $persistentStore.write(JSON.stringify(store), STORE_KEY);
}

function accountKey(headers) {
  return String(getHeader(headers, "chatgpt-account-id") || "default");
}

function modelFromHeaders(headers) {
  const direct = getHeader(headers, "x-codex-model");
  if (direct) return String(direct);
  const hint = String(getHeader(headers, "x-codex-routing-hint") || "");
  const match = hint.match(/(?:^|[;,\s])model=([^;,\s]+)/i);
  return match ? match[1] : "";
}

function handlesModel(headers, options) {
  const model = modelFromHeaders(headers);
  return !model || model === options.model;
}

function entryKey(headers, options) {
  return accountKey(headers) + "\u0000" + options.model;
}

function usable(entry, now) {
  return !!(entry && entry.value && entry.expiresAt > now);
}

function shouldRenew(entry, now) {
  return !usable(entry, now) || entry.refreshAt <= now;
}

function makeEntry(token, options, now) {
  return {
    value: token.value,
    fingerprint: token.fingerprint,
    blocks: token.blocks,
    length: token.value.length,
    issuedAt: token.issuedAt,
    acquiredAt: now,
    refreshAt: token.issuedAt + options.ttl - options.renew,
    expiresAt: token.issuedAt + options.ttl - 30,
    nextProbeAt: 0,
    probeUntil: 0,
    strikes: 0
  };
}

function cleanFlows(store, now) {
  for (const id of Object.keys(store.flows)) {
    if (!store.flows[id] || now - store.flows[id].createdAt > 600) delete store.flows[id];
  }
}

function shortId(value) {
  value = String(value || "");
  return value ? value.slice(-8) : "-";
}

function requestContext(headers) {
  let turn = "";
  try {
    turn = JSON.parse(String(getHeader(headers, "x-codex-turn-metadata") || "{}")).turn_id || "";
  } catch (_) {}
  return {
    thread: shortId(getHeader(headers, "thread-id") || getHeader(headers, "session-id")),
    turn: shortId(turn)
  };
}

function addHistory(store, event) {
  if (!Array.isArray(store.history)) store.history = [];
  store.history.push(event);
  if (store.history.length > 12) store.history = store.history.slice(-12);
}

function updateHistory(store, id, fields) {
  if (!id || !Array.isArray(store.history)) return;
  for (let index = store.history.length - 1; index >= 0; index--) {
    if (store.history[index].id === id) {
      Object.assign(store.history[index], fields);
      return;
    }
  }
}

function recordFlow(id, key, entry, injected, now, headers) {
  if (!id) return;
  const store = readStore();
  cleanFlows(store, now);
  store.flows[id] = {
    key,
    injected,
    fingerprint: entry ? entry.fingerprint : "",
    createdAt: now
  };
  const context = requestContext(headers);
  addHistory(store, {id, type: "request", at: now, injected, thread: context.thread, turn: context.turn});
  const active = store.entries[key];
  if (injected && active && active.fingerprint === entry.fingerprint) {
    active.lastInjectedAt = now;
    active.lastInjectedThread = context.thread;
    active.injectionCount = (active.injectionCount || 0) + 1;
  }
  writeStore(store);
}

function formatTime(seconds) {
  if (!seconds) return "-";
  const date = new Date(seconds * 1000);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(value => String(value).padStart(2, "0")).join(":");
}

function duration(seconds) {
  seconds = Math.max(0, Math.floor(seconds || 0));
  if (seconds < 60) return seconds + " 秒";
  return Math.floor(seconds / 60) + " 分 " + (seconds % 60) + " 秒";
}

function latestEntry(store) {
  const entries = Object.values(store.entries || {});
  return entries.sort((left, right) => (right.acquiredAt || 0) - (left.acquiredAt || 0))[0];
}

function historyLine(event) {
  let label;
  if (event.type === "probe") {
    label = event.accepted ? "✅ 探针抓到 292" : "⚪ 探针未通过 " + (event.stateLength || 0);
  } else {
    label = event.injected ? "✅ 已注入 292" : "⚪ 未注入";
    if (event.responseLength) label += " → 响应 " + event.responseLength;
    if (event.captured) label += "／已抓到 292";
  }
  return formatTime(event.at) + "  " + label + (event.thread && event.thread !== "-" ? "  会话…" + event.thread : "");
}

function panelView(store, options, now) {
  const entry = latestEntry(store);
  const active = usable(entry, now);
  const probing = !!(entry && entry.probeUntil > now);
  const cooling = !!(entry && entry.nextProbeAt > now);
  const lines = [];
  let title = "Codex 292：等待采集";
  let style = "info";

  if (active) {
    title = "Codex 292：正在复用";
    style = "good";
    lines.push("现在发送：会注入 292");
    lines.push("TTL 剩余：" + duration(entry.expiresAt - now));
    if (entry.refreshAt > now) lines.push("距离续期：" + duration(entry.refreshAt - now));
    else if (probing) lines.push("续期：正在尝试，完成后再发送");
    else if (cooling) lines.push("续期：上次未通过，" + duration(entry.nextProbeAt - now) + "后重试");
    else lines.push("续期：发送前先尝试续期");
    lines.push("累计注入：" + (entry.injectionCount || 0) + " 次");
  } else if (probing) {
    lines.push("现在发送：正在采集，尚无 292");
  } else if (cooling) {
    lines.push("现在发送：不会注入");
    lines.push("探针冷却：" + duration(entry.nextProbeAt - now));
  } else {
    lines.push("现在发送：先采集；成功后同次注入");
  }

  if (store.lastProbe) {
    const rejectedRenewal = active && store.lastProbe.accepted === false && store.lastProbe.at >= entry.acquiredAt;
    const probe = "HTTP " + (store.lastProbe.status || "-") + "／state " + (store.lastProbe.stateLength || 0);
    lines.push(rejectedRenewal
      ? "最近续期：" + probe + " 未通过；继续复用缓存 292／" + formatTime(store.lastProbe.at)
      : "最近探针：" + probe + "／" + formatTime(store.lastProbe.at));
  }
  const history = (store.history || []).slice(-6).reverse();
  if (history.length) {
    lines.push("", "最近记录：");
    for (const event of history) lines.push(historyLine(event));
  }
  return {title, content: lines.join("\n"), style, icon: "bolt.shield.fill", "icon-color": active ? "#34C759" : "#FF9F0A"};
}

function copyProbeHeaders(source) {
  const result = {};
  for (const name of [
    "authorization",
    "chatgpt-account-id",
    "originator",
    "user-agent",
    "version",
    "openai-beta",
    "x-codex-installation-id"
  ]) {
    const value = getHeader(source, name);
    if (value) result[name] = value;
  }
  result["content-type"] = "application/json";
  result.accept = "text/event-stream";
  result.connection = "close";
  result[PROBE_HEADER] = "1";
  return result;
}

function probeBody(model) {
  return JSON.stringify({
    model,
    instructions: "Reply with OK.",
    input: [{
      type: "message",
      role: "user",
      content: [{type: "input_text", text: "Reply with OK."}]
    }],
    stream: true,
    store: false,
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"]
  });
}

function streamCompleted(body) {
  return typeof body === "string" &&
    (/event:\s*response\.completed/.test(body) || /"type"\s*:\s*"response\.completed"/.test(body));
}

function retryDelay(headers, fallback) {
  const seconds = Number(getHeader(headers, "retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(fallback, seconds) : fallback;
}

function probeRetryDelay(status, observed, headers, options) {
  if (status === 401 || status === 403) return options.ttl;
  if (status === 429) return retryDelay(headers, options.cooldown);
  if (!status || (status === 200 && observed)) return Math.min(options.cooldown, 30);
  return options.cooldown;
}

function freshProbeDescriptor(descriptor, nonce) {
  const named = String(descriptor).match(/^[^,=]{1,128}\s*=\s*(socks5(?:-tls)?,.*)$/i);
  const parts = String(named ? named[1] : descriptor).split(",").map(value => value.trim());
  const id = String(nonce || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)))
    .replace(/[^A-Za-z0-9]/g, "").slice(-24) || "0";
  if (/^socks5(?:-tls)?$/i.test(parts[0]) && /(?:^|\.)1024proxy\.io$/i.test(parts[1]) && parts[3] && !parts[3].includes("=")) {
    parts[3] = parts[3].replace(/-sid-.+?-t-\d+$/i, "") + `-sid-CSSS${id}-t-1`;
  }
  return `CSSS-${id} = ${parts.join(", ")}`;
}

function applyProbeRoute(request, options, store) {
  const descriptor = String(store && store.read(PROBE_POLICY_KEY) || "").trim();
  const policies = descriptor.split("|").map(value => value.trim()).filter(Boolean);
  if (policies.length > 1 && descriptor.length <= 2048 && policies.every(value => value.length <= 128)) {
    let cursor = Number(store && store.read(PROBE_POLICY_CURSOR_KEY));
    if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
    request.policy = policies[cursor % policies.length];
    if (store && typeof store.write === "function") store.write(String((cursor + 1) % policies.length), PROBE_POLICY_CURSOR_KEY);
    return "policy";
  }
  if (descriptor.length <= 2048 && /^socks5(?:-tls)?,/i.test(descriptor)) {
    const routed = /(?:^|,)\s*underlying-proxy\s*=/i.test(descriptor)
      ? descriptor
      : `${descriptor}, underlying-proxy=DIRECT`;
    request["policy-descriptor"] = freshProbeDescriptor(routed);
    return "SOCKS5";
  }
  if (descriptor && descriptor.length <= 128) {
    request.policy = descriptor;
    return "policy";
  }
  if (options.policy) {
    request.policy = options.policy;
    return "policy";
  }
  return "rules";
}

function renew(url, requestHeaders, options, key, callback) {
  const now = Math.floor(Date.now() / 1000);
  const store = readStore();
  const current = store.entries[key] || {};
  if (current.probeUntil > now || current.nextProbeAt > now) {
    callback(undefined, current);
    return;
  }

  current.probeUntil = now + options.probeTimeout + 5;
  current.nextProbeAt = now + options.cooldown;
  store.entries[key] = current;
  writeStore(store);

  const request = {
    url,
    headers: copyProbeHeaders(requestHeaders),
    body: probeBody(options.model),
    timeout: options.probeTimeout,
    "auto-redirect": false,
    "auto-cookie": false
  };
  const route = applyProbeRoute(request, options, typeof $persistentStore !== "undefined" ? $persistentStore : null);

  $httpClient.post(request, (error, response, body) => {
    const finishedAt = Math.floor(Date.now() / 1000);
    const latest = readStore();
    const old = latest.entries[key] || current;
    const status = response && Number(response.status);
    const state = !error && response ? extractState(response.headers) : undefined;
    const token = status === 200 && streamCompleted(body) ? acceptState(state, options, finishedAt) : undefined;
    const observed = parseState(state);
    latest.lastProbe = {
      at: finishedAt,
      status: status || 0,
      stateLength: state ? state.length : 0,
      blocks: observed ? observed.blocks : 0,
      accepted: !!token
    };
    addHistory(latest, {type: "probe", at: finishedAt, status: status || 0, stateLength: state ? state.length : 0, accepted: !!token});

    if (token) {
      latest.entries[key] = makeEntry(token, options, finishedAt);
      writeStore(latest);
      if (typeof $notification !== "undefined") {
        $notification.post("Codex 292 已采集", "开始跨会话复用", "TTL 60 分钟，50 分钟后自动续期", {"auto-dismiss": true});
      }
      console.log("[renew] accepted state len=" + token.value.length + " blocks=" + token.blocks + " route=" + route);
      callback(undefined, latest.entries[key]);
      return;
    }

    old.probeUntil = 0;
    old.nextProbeAt = finishedAt + probeRetryDelay(status, observed, response && response.headers, options);
    latest.entries[key] = old;
    writeStore(latest);
    console.log("[renew] rejected status=" + (status || "network") + " state_len=" + (state ? state.length : 0));
    callback(error || "state rejected", old);
  });
}

function finishRequest(headers, key, entry) {
  const now = Math.floor(Date.now() / 1000);
  const injected = usable(entry, now);
  recordFlow($request.id, key, entry, injected, now, headers);
  if (injected) {
    console.log("[request] state injected len=" + entry.length + " expires_in=" + (entry.expiresAt - now));
    $done({headers: setHeader(headers, "x-codex-turn-state", entry.value)});
  } else {
    console.log("[request] no usable state; request passed through");
    $done({});
  }
}

function handleRequest(options) {
  const headers = $request.headers || {};
  if (getHeader(headers, PROBE_HEADER) === "1") {
    $done({});
    return;
  }
  if (!handlesModel(headers, options)) {
    $done({});
    return;
  }
  if (options.forceHttp && /websocket/i.test(String(getHeader(headers, "upgrade") || ""))) {
    console.log("[transport] websocket blocked; waiting for HTTP fallback");
    $done({abort: true});
    return;
  }

  const key = entryKey(headers, options);
  const entry = readStore().entries[key];
  const now = Math.floor(Date.now() / 1000);
  if (!shouldRenew(entry, now)) {
    finishRequest(headers, key, entry);
    return;
  }

  renew($request.url, headers, options, key, (_, renewed) => {
    const selected = usable(renewed, Math.floor(Date.now() / 1000)) ? renewed : entry;
    finishRequest(headers, key, selected);
  });
}

function handleResponse(options) {
  const requestHeaders = $request.headers || {};
  if (getHeader(requestHeaders, PROBE_HEADER) === "1") {
    $done({});
    return;
  }
  if (!handlesModel(requestHeaders, options)) {
    $done({});
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const store = readStore();
  cleanFlows(store, now);
  const flow = store.flows[$request.id];
  if ($request.id) delete store.flows[$request.id];
  const key = flow ? flow.key : entryKey(requestHeaders, options);
  const current = store.entries[key];
  const state = extractState($response.headers);
  const token = Number($response.status) === 200 ? acceptState(state, options, now) : undefined;
  const observed = parseState(state);
  updateHistory(store, $request.id, {
    responseAt: now,
    responseStatus: Number($response.status),
    responseLength: state ? state.length : 0,
    responseBlocks: observed ? observed.blocks : 0
  });

  if (!flow || !flow.injected) {
    if (token) {
      store.entries[key] = makeEntry(token, options, now);
      updateHistory(store, $request.id, {captured: true});
      if (typeof $notification !== "undefined") {
        $notification.post("Codex 292 已采集", "开始跨会话复用", "TTL 60 分钟，50 分钟后自动续期", {"auto-dismiss": true});
      }
      console.log("[response] pass-through state captured len=" + token.value.length);
    }
  } else if (state && current && flow.fingerprint === current.fingerprint) {
    current.strikes = token ? 0 : (current.strikes || 0) + 1;
    store.entries[key] = current;
    const observed = parseState(state);
    console.log("[response] injected state observed blocks=" + (observed ? observed.blocks : "invalid") + " strikes=" + current.strikes);
  }

  writeStore(store);
  $done({});
}

function handlePanel(options) {
  $done(panelView(readStore(), options, Math.floor(Date.now() / 1000)));
}

function main() {
  const options = parseOptions(typeof $argument === "string" ? $argument : "");
  if (typeof $input !== "undefined" && $input && $input.purpose === "panel") handlePanel(options);
  else if ($script.type === "http-request") handleRequest(options);
  else handleResponse(options);
}

if (typeof module !== "undefined") {
  module.exports = {
    applyProbeRoute,
    acceptState,
    accountKey,
    decodeBase64Url,
    entryKey,
    extractState,
    formatTime,
    freshProbeDescriptor,
    getHeader,
    handlesModel,
    historyLine,
    makeEntry,
    modelFromHeaders,
    panelView,
    parseOptions,
    parseState,
    probeRetryDelay,
    requestContext,
    setHeader,
    shouldRenew,
    streamCompleted,
    usable
  };
}
if (typeof $done === "function") main();
