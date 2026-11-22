// src/core/text.ts
var letterCounts = (text) => {
  let kana = 0;
  let han = 0;
  let latin = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 12352 && code <= 12447 || code >= 12448 && code <= 12543) kana++;
    else if (code >= 19968 && code <= 40959) han++;
    else if (code >= 65 && code <= 90 || code >= 97 && code <= 122) latin++;
  }
  return { kana, han, latin };
};
var sourceLang = (text) => {
  const { han, latin } = letterCounts(text);
  return han > latin ? "zh" : "en";
};
var CHUNK_SEPARATORS = ["\n\n", "\n", ". ", "\u3002", " "];
var splitChunks = (text, max, level = 0) => {
  if (text.length <= max) return [text];
  const separator = CHUNK_SEPARATORS[level];
  if (separator === void 0) {
    const pieces = [];
    for (let at = 0; at < text.length; at += max) pieces.push(text.slice(at, at + max));
    return pieces;
  }
  const chunks = [];
  let current = "";
  for (const part of text.split(separator)) {
    if (!part.trim()) continue;
    const joined = current ? current + separator + part : part;
    if (joined.length <= max) {
      current = joined;
      continue;
    }
    if (current) chunks.push(current);
    current = "";
    if (part.length <= max) current = part;
    else chunks.push(...splitChunks(part, max, level + 1));
  }
  if (current) chunks.push(current);
  return chunks;
};
var hashText = (text) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${(h >>> 0).toString(36)}.${text.length}`;
};

// src/core/translator.ts
var MAX_TOKENS = 4096;
var fillTemplate = (value, vars) => {
  if (typeof value === "string") {
    return value.replace(/\{\{(text|source_lang)\}\}/g, (_match, key) => vars[key]);
  }
  if (Array.isArray(value)) return value.map((item) => fillTemplate(item, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillTemplate(item, vars)]));
  }
  return value;
};
var replyText = (reply, chat) => {
  if (!reply || typeof reply !== "object" || !("choices" in reply)) return void 0;
  if (!Array.isArray(reply.choices)) return void 0;
  const choice = reply.choices[0];
  if (!choice || typeof choice !== "object") return void 0;
  if (!chat) return "text" in choice ? choice.text : void 0;
  const message = "message" in choice ? choice.message : void 0;
  return message && typeof message === "object" && "content" in message ? message.content : void 0;
};
var requestTranslation = async (text, translator, post, signal) => {
  const vars = { text, source_lang: sourceLang(text) };
  const request = {
    ...translator.model === void 0 ? {} : { model: translator.model },
    temperature: 0,
    max_tokens: MAX_TOKENS,
    ...translator.stop === void 0 ? {} : { stop: translator.stop },
    ...translator.prompt === void 0 ? { messages: translator.messages } : { prompt: translator.prompt },
    ...translator.body
  };
  const reply = await post(translator.url, JSON.stringify(fillTemplate(request, vars)), signal);
  if (reply.status < 200 || reply.status >= 300) {
    throw new Error(`${translator.url} answered HTTP ${reply.status}: ${reply.text.slice(0, 200)}`);
  }
  const out = replyText(JSON.parse(reply.text), translator.prompt === void 0);
  if (typeof out !== "string") throw new Error(`${translator.url} replied without text`);
  return out;
};

// src/core/block.ts
var DEFAULT_CHUNK_CHARS = 4e3;
var DEFAULT_CONCURRENCY = 3;
var translatorAttempts = (translators, post) => translators.map((translator) => (chunk, signal) => requestTranslation(chunk, translator, post, signal));
var chunkPlan = (translators) => ({
  chunkChars: translators[0]?.chunkChars ?? DEFAULT_CHUNK_CHARS,
  concurrency: translators[0]?.concurrency ?? DEFAULT_CONCURRENCY
});
var translateChunk = async (chunk, options) => {
  const key = hashText(chunk);
  const cached = options.cache?.get(key);
  if (cached !== void 0) return cached;
  let lastError = new Error("no translator configured");
  for (const [index, attempt] of options.attempts.entries()) {
    if (options.signal.aborted || options.active?.() === false) return void 0;
    try {
      const ja = (await attempt(chunk, options.signal)).trim();
      if (!ja) throw new Error("empty translation");
      options.cache?.set(key, ja);
      return ja;
    } catch (error) {
      lastError = error;
      options.onAttemptError?.(error, index + 1);
    }
  }
  throw lastError;
};
var translateBlock = async (text, options) => {
  const chunks = splitChunks(text, options.chunkChars);
  const parts = [];
  let next = 0;
  let abandoned = false;
  let failure;
  const worker = async () => {
    while (!abandoned && !failure && next < chunks.length) {
      const index = next++;
      const chunk = chunks[index];
      if (chunk === void 0) break;
      try {
        const ja = await translateChunk(chunk, options);
        if (ja === void 0) abandoned = true;
        else parts[index] = ja;
      } catch (error) {
        failure = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, chunks.length) }, worker));
  if (abandoned) return void 0;
  if (failure) throw failure.error;
  return parts.join("\n");
};

// src/core/http.ts
var REQUEST_TIMEOUT_MS = 6e4;
var fetchPost = async (url, body, signal) => {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  return { status: response.status, text: await response.text() };
};

// src/core/load.ts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// src/core/presets.ts
var PRESETS = {
  /**
   * PLaMo 3 Translate (pfnet/plamo-3-translate-*): PFML3 prompt on the
   * completions endpoint. The context line keeps identifiers and paths as
   * written; `form=plain` asks for だ/である style. 1500-char chunks with 8
   * in flight match `llama-server -np 8`.
   */
  "plamo-3-translate": {
    prompt: "<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>context<|plamo:msg|>Internal reasoning notes of an AI coding assistant working in a software repository. Code identifiers, commands and file paths stay as written.<|plamo:tag|>input<|plamo:msg|>{{text}}<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>plain<|plamo:msg|>",
    stop: ["<|plamo:tag|>", "<|plamo:bos|>"],
    chunkChars: 1500,
    concurrency: 8
  },
  /** HY-MT1.5 (tencent/HY-MT1.5-*): the model card's prompt and sampling, on the chat endpoint. */
  "hy-mt": {
    messages: [
      {
        role: "user",
        content: "Translate the following segment into Japanese, without additional explanation.\n\n{{text}}"
      }
    ],
    body: { temperature: 0.7, top_k: 20, top_p: 0.6, repeat_penalty: 1.05 }
  }
};

// src/core/config.ts
var parseConfig = (value) => {
  if (!value || typeof value !== "object" || !("translators" in value) || !Array.isArray(value.translators)) {
    throw new Error("config needs a translators array");
  }
  return {
    translators: value.translators.map((entry, index) => parseTranslator(entry, `translators[${index}]`))
  };
};
var isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
var parseTranslator = (entry, at) => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${at} must be an object`);
  const fields = new Map(Object.entries(entry));
  const presetName = fields.get("preset");
  let preset = {};
  if (presetName !== void 0) {
    const found = typeof presetName === "string" ? PRESETS[presetName] : void 0;
    if (!found) throw new Error(`${at}.preset must be one of: ${Object.keys(PRESETS).join(", ")}`);
    preset = found;
  }
  const url = fields.get("url");
  if (typeof url !== "string" || !url) throw new Error(`${at}.url must be a URL string`);
  const ownShape = fields.has("prompt") || fields.has("messages");
  const prompt = ownShape ? fields.get("prompt") : preset.prompt;
  const messages = ownShape ? fields.get("messages") : preset.messages;
  if (prompt !== void 0 && typeof prompt !== "string") throw new Error(`${at}.prompt must be a string`);
  if (messages !== void 0 && !Array.isArray(messages)) throw new Error(`${at}.messages must be an array`);
  if (prompt === void 0 === (messages === void 0)) {
    throw new Error(`${at} needs exactly one of prompt or messages (or a preset)`);
  }
  if (!JSON.stringify(prompt ?? messages).includes("{{text}}")) {
    throw new Error(`${at}.prompt or messages must contain {{text}}`);
  }
  const model = fields.get("model");
  if (model !== void 0 && typeof model !== "string") throw new Error(`${at}.model must be a string`);
  const stop = fields.has("stop") ? fields.get("stop") : preset.stop;
  if (stop !== void 0 && !isStringArray(stop)) throw new Error(`${at}.stop must be an array of strings`);
  const ownBody = fields.get("body");
  if (ownBody !== void 0 && (!ownBody || typeof ownBody !== "object" || Array.isArray(ownBody))) {
    throw new Error(`${at}.body must be an object`);
  }
  const body = preset.body || ownBody ? { ...preset.body, ...ownBody ? Object.fromEntries(Object.entries(ownBody)) : {} } : void 0;
  const count = (key) => {
    const value = fields.has(key) ? fields.get(key) : preset[key];
    if (value === void 0) return void 0;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(`${at}.${key} must be a positive integer`);
    }
    return value;
  };
  return {
    url,
    model,
    prompt,
    messages,
    stop,
    body,
    chunkChars: count("chunkChars"),
    concurrency: count("concurrency")
  };
};

// src/core/load.ts
var configPath = (env = process.env) => env.THINKING_JA_CONFIG || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "thinking-ja", "config.json");
var loadConfig = async (path = configPath()) => {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return void 0;
    throw error;
  }
  return parseConfig(JSON.parse(raw));
};

// src/harness/dsh/host.ts
var TRANSLATE_PATH = "/_thinking-ja/translate";
var MAX_BODY_BYTES = 256 * 1024;
var MAX_CACHED = 500;
var name = "thinking-ja";
var inject = ["webServer", "connection"];
var send = (response, status, body) => {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
};
var readBody = async (request) => {
  const parts = [];
  let size = 0;
  for await (const part of request) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return void 0;
    parts.push(buffer);
  }
  return Buffer.concat(parts).toString("utf8");
};
function apply(ctx) {
  const lifetime = new AbortController();
  const cache = /* @__PURE__ */ new Map();
  const translate = (text) => {
    const key = hashText(text);
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = loadConfig().then((config) => {
      const translators = config?.translators ?? [];
      if (!translators.length) throw new Error(`${configPath()} has no translators`);
      return translateBlock(text, {
        attempts: translatorAttempts(translators, fetchPost),
        ...chunkPlan(translators),
        signal: lifetime.signal
      });
    });
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value ?? key);
    return pending;
  };
  const handler = async (request, response) => {
    const rejection = ctx.connection.requestRejection(request);
    if (rejection !== void 0) {
      response.statusCode = rejection;
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      send(response, 405, { error: "POST only" });
      return;
    }
    const raw = await readBody(request);
    let text;
    try {
      const body = raw === void 0 ? void 0 : JSON.parse(raw);
      text = body && typeof body === "object" && "text" in body ? body.text : void 0;
    } catch {
      text = void 0;
    }
    if (typeof text !== "string" || !text.trim()) {
      send(response, 400, { error: "expected a JSON body with non-empty text" });
      return;
    }
    try {
      const ja = await translate(text.trim());
      if (ja === void 0) send(response, 503, { error: "translation abandoned" });
      else send(response, 200, { ja });
    } catch (error) {
      ctx.logger.warn(`thinking-ja: translation failed: ${String(error)}`);
      send(response, 502, { error: String(error) });
    }
  };
  ctx.effect(() => () => lifetime.abort(), "thinking-ja: in-flight translations");
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: TRANSLATE_PATH, handler }), "thinking-ja: route");
}
export {
  TRANSLATE_PATH,
  apply,
  inject,
  name
};
