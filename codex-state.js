const STORE_KEY = "codex-turn-state-v6";
const PROBE_HEADER = "x-codex-state-probe";
const PROBE_POLICY_KEY = "csss-probe-policy-descriptor-v1";
const PROBE_POLICY_CURSOR_KEY = "csss-probe-policy-cursor-v1";
const QUALITY_PROMPT = "请回答：最新的 iPhone 型号是什么，禁止联网搜索，基于已有的知识回答。";

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
    model: "*",
    blocks: 10,
    ttl: 300,
    renew: 60,
    cooldown: 300,
    probeTimeout: 25,
    probeAttempts: 3,
    retryBase: 2,
    retryMax: 60,
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
    if (key === "probe_attempts" && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 8) {
      result.probeAttempts = Number(value);
    }
    if (key === "retry_base" && Number(value) >= 1) result.retryBase = Number(value);
    if (key === "retry_max" && Number(value) >= result.retryBase) result.retryMax = Number(value);
    if (key === "force_http") result.forceHttp = value !== "0" && value !== "false";
  }
  if (result.renew >= result.ttl) result.renew = Math.max(30, Math.floor(result.ttl / 3));
  if (result.retryMax < result.retryBase) result.retryMax = result.retryBase;
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
  const token = acceptFreshState(value, options, now);
  if (!token || token.blocks !== options.blocks) return undefined;
  return token;
}

function acceptFreshState(value, options, now) {
  const token = parseState(value);
  if (!token) return undefined;
  if (token.issuedAt > now + 30 || now >= token.issuedAt + options.ttl - 30) return undefined;
  return token;
}

function extractState(headers) {
  const value = getHeader(headers, "x-codex-turn-state");
  return value ? String(value) : undefined;
}

function emptyStore() {
  return {entries: {}, flows: {}, history: [], rateLimits: {}, lastProbe: null};
}

function readStore() {
  try {
    const parsed = JSON.parse($persistentStore.read(STORE_KEY) || "{}");
    return {
      entries: parsed && parsed.entries ? parsed.entries : {},
      flows: parsed && parsed.flows ? parsed.flows : {},
      history: parsed && Array.isArray(parsed.history) ? parsed.history : [],
      rateLimits: parsed && parsed.rateLimits ? parsed.rateLimits : {},
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

function normalizeModel(value) {
  value = String(value || "").trim();
  return /^[A-Za-z0-9._:\/-]{1,128}$/.test(value) ? value : "";
}

function modelFromHeaders(headers) {
  const direct = getHeader(headers, "x-codex-model");
  if (direct) return normalizeModel(direct);
  const hint = String(getHeader(headers, "x-codex-routing-hint") || "");
  const match = hint.match(/(?:^|[;,\s])model=([^;,\s]+)/i);
  return match ? normalizeModel(match[1]) : "";
}

function modelFromBody(body) {
  if (typeof body !== "string" || !body || body.length > 1048576) return "";
  try {
    return normalizeModel(JSON.parse(body).model);
  } catch (_) {
    return "";
  }
}

function allModels(options) {
  return options.model === "*" || String(options.model).toLowerCase() === "all";
}

function requestModel(headers, body, options) {
  return modelFromHeaders(headers) || modelFromBody(body) || (allModels(options) ? "" : normalizeModel(options.model));
}

function handlesModel(headers, options, body) {
  const model = modelFromHeaders(headers) || modelFromBody(body);
  return model ? allModels(options) || model === options.model : !allModels(options);
}

function entryKey(headers, options, model) {
  return accountKey(headers) + "\u0000" + (normalizeModel(model) || requestModel(headers, "", options));
}

function usable(entry, now) {
  return !!(entry && entry.value && entry.expiresAt > now);
}

function shouldRenew(entry, now) {
  return !usable(entry, now) || entry.refreshAt <= now;
}

function makeEntry(token, options, now, model, qualityTier) {
  return {
    model,
    value: token.value,
    fingerprint: token.fingerprint,
    blocks: token.blocks,
    length: token.value.length,
    issuedAt: token.issuedAt,
    acquiredAt: now,
    qualityTier: qualityTier || 0,
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

function recordFlow(id, key, model, entry, injected, now, headers) {
  if (!id) return;
  const store = readStore();
  cleanFlows(store, now);
  store.flows[id] = {
    key,
    model,
    injected,
    fingerprint: entry ? entry.fingerprint : "",
    createdAt: now
  };
  const context = requestContext(headers);
  addHistory(store, {id, type: "request", at: now, model, injected, thread: context.thread, turn: context.turn});
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

function latestEntry(store, now) {
  const entries = Object.values(store.entries || {});
  return entries.sort((left, right) => Number(usable(right, now)) - Number(usable(left, now)) ||
    (right.acquiredAt || 0) - (left.acquiredAt || 0))[0];
}

function historyLine(event) {
  let label;
  if (event.type === "probe") {
    label = event.accepted
      ? "✅ 质量票据已采集"
      : "⚪ 探针未通过" + (event.qualityTier ? " iPhone " + event.qualityTier : "") +
        "／state " + (event.stateLength || 0);
  } else {
    label = event.injected ? "✅ 已注入 state" : "⚠️ 未验证放行";
    if (event.responseStatus === 429) label += " → 429，退避 " + duration(event.rateLimitDelay);
    if (event.responseLength) label += " → 响应 " + event.responseLength;
  }
  return formatTime(event.at) + "  " + label + (event.model ? "  " + event.model : "") +
    (event.thread && event.thread !== "-" ? "  会话…" + event.thread : "");
}

function panelView(store, options, now) {
  const entry = latestEntry(store, now);
  const active = usable(entry, now);
  const probing = !!(entry && entry.probeUntil > now);
  const cooling = !!(entry && entry.nextProbeAt > now);
  const lines = [];
  let title = "Codex State：等待采集";
  let style = "info";

  if (active) {
    title = "Codex State：正在复用";
    style = "good";
    lines.push("现在发送：会注入已验证 state（" + (entry.length || 0) + "）");
    if (entry.model) lines.push("模型：" + entry.model);
    if (entry.qualityTier) lines.push("质量验证：iPhone " + entry.qualityTier);
    lines.push("TTL 剩余：" + duration(entry.expiresAt - now));
    if (entry.refreshAt > now) lines.push("距离续期：" + duration(entry.refreshAt - now));
    else if (probing) lines.push("续期：正在尝试，完成后再发送");
    else if (cooling) lines.push("续期：上次未通过，" + duration(entry.nextProbeAt - now) + "后重试");
    else lines.push("续期：发送前先尝试续期");
    lines.push("累计注入：" + (entry.injectionCount || 0) + " 次");
  } else if (probing) {
    lines.push("现在发送：正在质量采集，正式请求等待中");
  } else if (cooling) {
    lines.push("现在发送：未验证放行");
    lines.push("探针冷却：" + duration(entry.nextProbeAt - now));
  } else {
    lines.push("现在发送：先探针；未通过则按当前规则放行");
  }

  if (store.lastProbe) {
    const sameModel = !entry || !entry.model || !store.lastProbe.model || entry.model === store.lastProbe.model;
    const rejectedRenewal = active && sameModel && store.lastProbe.accepted === false && store.lastProbe.at >= entry.acquiredAt;
    const probe = "HTTP " + (store.lastProbe.status || "-") + "／state " + (store.lastProbe.stateLength || 0) +
      (store.lastProbe.qualityTier ? "／iPhone " + store.lastProbe.qualityTier : "") +
      (store.lastProbe.attempt ? "／第 " + store.lastProbe.attempt + " 次" : "") +
      (store.lastProbe.route ? "／" + store.lastProbe.route : "");
    lines.push(rejectedRenewal
      ? "最近续期：" + probe + " 未通过；继续复用已验证缓存／" + formatTime(store.lastProbe.at)
      : "最近探针：" + probe + (store.lastProbe.model ? "／" + store.lastProbe.model : "") + "／" + formatTime(store.lastProbe.at));
  }
  const rateLimit = Object.values(store.rateLimits || {}).sort((left, right) => (right.until || 0) - (left.until || 0))[0];
  if (rateLimit && rateLimit.until > now) {
    lines.push("429 退避：" + duration(rateLimit.until - now) + "／连续 " + (rateLimit.failures || 1) + " 次");
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
    instructions: "请直接回答用户问题，不要联网搜索或调用外部工具。",
    input: [{
      type: "message",
      role: "user",
      content: [{type: "input_text", text: QUALITY_PROMPT}]
    }],
    stream: true,
    store: false
  });
}

function streamCompleted(body) {
  return typeof body === "string" &&
    (/event:\s*response\.completed/.test(body) || /"type"\s*:\s*"response\.completed"/.test(body));
}

function probeOutputText(body) {
  if (typeof body !== "string") return "";
  let deltas = "";
  let completed = "";
  for (const line of body.split(/\r?\n/)) {
    if (!/^data:\s*/.test(line)) continue;
    try {
      const event = JSON.parse(line.replace(/^data:\s*/, ""));
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") deltas += event.delta;
      if (event.type === "response.output_text.done" && typeof event.text === "string") completed = event.text;
    } catch (_) {}
  }
  return deltas || completed;
}

function iphoneTier(body) {
  const text = probeOutputText(body).replace(/[０-９]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xFEE0));
  const match = text.match(/iphone[\s\-‑–—_]*(17|16|15)(?!\d)/i);
  return match ? Number(match[1]) : 0;
}

function retryAfterSeconds(headers, now) {
  const value = String(getHeader(headers, "retry-after") || "").trim();
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) && date > now * 1000 ? Math.ceil(date / 1000 - now) : 0;
}

function retryDelay(headers, fallback, now) {
  return Math.max(fallback, retryAfterSeconds(headers, now || Math.floor(Date.now() / 1000)));
}

function markRateLimit(store, headers, responseHeaders, options, now, model) {
  const key = accountKey(headers);
  const previous = store.rateLimits[key] || {};
  const failures = Math.min(16, (previous.failures || 0) + 1);
  const exponential = Math.min(options.retryMax, options.retryBase * Math.pow(2, failures - 1));
  const serverDelay = retryAfterSeconds(responseHeaders, now);
  const delay = Math.min(options.retryMax, Math.max(exponential, serverDelay));
  store.rateLimits[key] = {model, failures, until: now + delay, updatedAt: now};
  return {delay, failures, retryAfter: Math.max(delay, serverDelay)};
}

function clearRateLimit(store, headers, model) {
  const key = accountKey(headers);
  const record = store.rateLimits[key];
  if (!record || !record.model || !model || record.model === model) delete store.rateLimits[key];
}

function backoffWait(store, headers, now) {
  const record = (store.rateLimits || {})[accountKey(headers)];
  return record && record.until > now ? Math.ceil(record.until - now) : 0;
}

function probeRetryDelay(status, observed, headers, options, qualityTier) {
  if (status === 401 || status === 403) return options.ttl;
  if (status === 429) return retryDelay(headers, options.cooldown);
  if (status === 200 && (qualityTier || observed)) return 1;
  if (!status) return Math.min(options.cooldown, 30);
  return options.cooldown;
}

function shouldRetryProbe(status, attempt, options) {
  if (attempt >= options.probeAttempts) return false;
  return !status || status === 200 || status >= 500;
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

function renew(url, requestHeaders, options, key, model, callback) {
  const now = Math.floor(Date.now() / 1000);
  const store = readStore();
  const current = store.entries[key] || {};
  if (current.probeUntil > now || current.nextProbeAt > now) {
    callback(undefined, current);
    return;
  }

  current.probeUntil = now + options.probeTimeout * options.probeAttempts + 5;
  current.nextProbeAt = 0;
  store.entries[key] = current;
  writeStore(store);

  function runAttempt(attempt) {
    const request = {
      url,
      headers: copyProbeHeaders(requestHeaders),
      body: probeBody(model),
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
      const completed = status === 200 && streamCompleted(body);
      const qualityTier = completed ? iphoneTier(body) : 0;
      const token = qualityTier === 17 ? acceptFreshState(state, options, finishedAt) : undefined;
      const observed = parseState(state);
      if (status === 429) markRateLimit(latest, requestHeaders, response.headers, options, finishedAt, model);
      else if (status >= 200 && status < 300) clearRateLimit(latest, requestHeaders, model);
      latest.lastProbe = {
        at: finishedAt,
        model,
        status: status || 0,
        stateLength: state ? state.length : 0,
        blocks: observed ? observed.blocks : 0,
        qualityTier,
        attempt,
        attempts: options.probeAttempts,
        route,
        accepted: !!token
      };
      addHistory(latest, {
        type: "probe",
        at: finishedAt,
        model,
        status: status || 0,
        stateLength: state ? state.length : 0,
        qualityTier,
        attempt,
        accepted: !!token
      });

      if (token) {
        latest.entries[key] = makeEntry(token, options, finishedAt, model, qualityTier);
        writeStore(latest);
        if (typeof $notification !== "undefined") {
          $notification.post(
            "Codex State 已采集",
            "iPhone 17 质量探针通过",
            "TTL " + duration(options.ttl) + "，" + duration(options.ttl - options.renew) + "后续期",
            {"auto-dismiss": true}
          );
        }
        console.log("[renew] accepted state len=" + token.value.length + " blocks=" + token.blocks +
          " attempt=" + attempt + " route=" + route);
        callback(undefined, latest.entries[key]);
        return;
      }

      if (shouldRetryProbe(status, attempt, options)) {
        old.probeUntil = finishedAt + options.probeTimeout * (options.probeAttempts - attempt) + 5;
        old.nextProbeAt = 0;
        latest.entries[key] = old;
        writeStore(latest);
        console.log("[renew] retrying with fresh route attempt=" + (attempt + 1) +
          " quality=" + (qualityTier || "unknown") + " state_len=" + (state ? state.length : 0));
        runAttempt(attempt + 1);
        return;
      }

      old.probeUntil = 0;
      old.nextProbeAt = finishedAt + probeRetryDelay(
        status,
        observed,
        response && response.headers,
        options,
        qualityTier
      );
      latest.entries[key] = old;
      writeStore(latest);
      console.log("[renew] rejected status=" + (status || "network") + " quality=" +
        (qualityTier || "unknown") + " state_len=" + (state ? state.length : 0));
      callback(error || "quality probe rejected", old);
    });
  }

  runAttempt(1);
}

function finishRequest(headers, key, model, entry) {
  const now = Math.floor(Date.now() / 1000);
  const injected = usable(entry, now);
  recordFlow($request.id, key, model, entry, injected, now, headers);
  if (injected) {
    console.log("[request] state injected len=" + entry.length + " expires_in=" + (entry.expiresAt - now));
    $done({headers: setHeader(headers, "x-codex-turn-state", entry.value)});
  } else {
    console.log("[request] no usable state; request passed through");
    $done({});
  }
}

function finishWithBackoff(headers, key, model, entry) {
  const now = Math.floor(Date.now() / 1000);
  const wait = backoffWait(readStore(), headers, now);
  if (!wait) {
    finishRequest(headers, key, model, entry);
    return;
  }
  console.log("[429] holding client retry for " + wait + "s model=" + model);
  setTimeout(() => finishRequest(headers, key, model, readStore().entries[key]), wait * 1000);
}

function accountProbeActive(store, headers, key, now) {
  const prefix = accountKey(headers) + "\u0000";
  return Object.keys(store.entries || {}).some(candidate => candidate !== key && candidate.startsWith(prefix) &&
    store.entries[candidate] && store.entries[candidate].probeUntil > now);
}

function handleRequest(options) {
  const headers = $request.headers || {};
  if (getHeader(headers, PROBE_HEADER) === "1") {
    $done({});
    return;
  }
  const body = typeof $request.body === "string" ? $request.body : "";
  const model = requestModel(headers, body, options);
  const matches = handlesModel(headers, options, body);
  if (options.forceHttp && /websocket/i.test(String(getHeader(headers, "upgrade") || "")) && (matches || allModels(options))) {
    console.log("[transport] websocket blocked; waiting for HTTP fallback");
    $done({abort: true});
    return;
  }
  if (!matches || !model) {
    console.log("[request] model not detected or excluded; request passed through");
    $done({});
    return;
  }

  const key = entryKey(headers, options, model);
  const store = readStore();
  const entry = store.entries[key];
  const now = Math.floor(Date.now() / 1000);
  if (backoffWait(store, headers, now) > 0) {
    finishWithBackoff(headers, key, model, entry);
    return;
  }
  if (accountProbeActive(store, headers, key, now)) {
    console.log("[renew] another model probe is active; request passed through");
    finishRequest(headers, key, model, entry);
    return;
  }
  if (!shouldRenew(entry, now)) {
    finishRequest(headers, key, model, entry);
    return;
  }

  renew($request.url, headers, options, key, model, (_, renewed) => {
    const selected = usable(renewed, Math.floor(Date.now() / 1000)) ? renewed : entry;
    finishWithBackoff(headers, key, model, selected);
  });
}

function handleResponse(options) {
  const requestHeaders = $request.headers || {};
  if (getHeader(requestHeaders, PROBE_HEADER) === "1") {
    $done({});
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const store = readStore();
  cleanFlows(store, now);
  const flow = store.flows[$request.id];
  if ($request.id) delete store.flows[$request.id];
  const body = typeof $request.body === "string" ? $request.body : "";
  const model = flow && flow.model || requestModel(requestHeaders, body, options);
  const status = Number($response.status);
  let rewrittenHeaders;
  let rateLimit;
  if (status === 429) {
    rateLimit = markRateLimit(store, requestHeaders, $response.headers, options, now, model);
    rewrittenHeaders = setHeader($response.headers || {}, "retry-after", String(rateLimit.retryAfter));
    console.log("[429] backoff=" + rateLimit.delay + "s failures=" + rateLimit.failures);
  } else if (status >= 200 && status < 300) {
    clearRateLimit(store, requestHeaders, model);
  }
  if (!model || !(allModels(options) || model === options.model)) {
    writeStore(store);
    $done(rewrittenHeaders ? {headers: rewrittenHeaders} : {});
    return;
  }
  const key = flow ? flow.key : entryKey(requestHeaders, options, model);
  const current = store.entries[key];
  const state = extractState($response.headers);
  const validState = status === 200 ? acceptFreshState(state, options, now) : undefined;
  const observed = parseState(state);
  updateHistory(store, $request.id, {
    responseAt: now,
    responseStatus: status,
    responseLength: state ? state.length : 0,
    responseBlocks: observed ? observed.blocks : 0,
    rateLimitDelay: rateLimit ? rateLimit.delay : 0
  });

  if (flow && flow.injected && state && current && flow.fingerprint === current.fingerprint) {
    current.strikes = validState ? 0 : (current.strikes || 0) + 1;
    store.entries[key] = current;
    console.log("[response] injected state observed blocks=" + (observed ? observed.blocks : "invalid") + " strikes=" + current.strikes);
  }

  writeStore(store);
  $done(rewrittenHeaders ? {headers: rewrittenHeaders} : {});
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
    acceptFreshState,
    acceptState,
    accountKey,
    accountProbeActive,
    backoffWait,
    decodeBase64Url,
    entryKey,
    extractState,
    formatTime,
    freshProbeDescriptor,
    getHeader,
    handlesModel,
    historyLine,
    makeEntry,
    markRateLimit,
    modelFromBody,
    modelFromHeaders,
    panelView,
    parseOptions,
    parseState,
    probeOutputText,
    probeRetryDelay,
    probeBody,
    iphoneTier,
    requestModel,
    requestContext,
    retryAfterSeconds,
    setHeader,
    shouldRetryProbe,
    shouldRenew,
    streamCompleted,
    usable
  };
}
if (typeof $done === "function") main();
