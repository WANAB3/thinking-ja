#!/usr/bin/env node

// src/cli.ts
import { parseArgs } from "node:util";

// src/core/text.ts
var MIN_TRANSLATABLE_CHARS = 16;
var MIN_KANA_CHARS = 10;
var KANA_LETTER_RATIO = 0.2;
var letterCounts = (text) => {
  let kana = 0;
  let han = 0;
  let latin = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 12352 && code <= 12447 || code >= 12448 && code <= 12543)
      kana++;
    else if (code >= 19968 && code <= 40959)
      han++;
    else if (code >= 65 && code <= 90 || code >= 97 && code <= 122)
      latin++;
  }
  return { kana, han, latin };
};
var shouldTranslate = (text) => {
  if (text.trim().length < MIN_TRANSLATABLE_CHARS)
    return false;
  const { kana, han, latin } = letterCounts(text);
  const letters = kana + han + latin;
  return !(kana >= MIN_KANA_CHARS && letters > 0 && kana / letters > KANA_LETTER_RATIO);
};
var sourceLang = (text) => {
  const { han, latin } = letterCounts(text);
  return han > latin ? "zh" : "en";
};
var CHUNK_SEPARATORS = [`

`, `
`, ". ", "。", " "];
var splitChunks = (text, max, level = 0) => {
  if (text.length <= max)
    return [text];
  const separator = CHUNK_SEPARATORS[level];
  if (separator === undefined) {
    const pieces = [];
    for (let at = 0;at < text.length; at += max)
      pieces.push(text.slice(at, at + max));
    return pieces;
  }
  const chunks = [];
  let current = "";
  for (const part of text.split(separator)) {
    if (!part.trim())
      continue;
    const joined = current ? current + separator + part : part;
    if (joined.length <= max) {
      current = joined;
      continue;
    }
    if (current)
      chunks.push(current);
    current = "";
    if (part.length <= max)
      current = part;
    else
      chunks.push(...splitChunks(part, max, level + 1));
  }
  if (current)
    chunks.push(current);
  return chunks;
};
var hashText = (text) => {
  let h = 2166136261;
  for (let i = 0;i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${(h >>> 0).toString(36)}.${text.length}`;
};
var BOLD_LINE = /^(\s*)\*\*((?:(?!\*\*).)+)\*\*\s*$/;
var plainText = (ja) => {
  let fenced = false;
  return ja.split(`
`).map((line) => {
    if (line.trimStart().startsWith("```"))
      fenced = !fenced;
    else if (!fenced)
      return line.replace(BOLD_LINE, "$1$2");
    return line;
  }).join(`
`);
};

// src/core/translator.ts
var MAX_TOKENS = 4096;
var fillTemplate = (value, vars) => {
  if (typeof value === "string") {
    return value.replace(/\{\{(text|source_lang)\}\}/g, (_match, key) => vars[key]);
  }
  if (Array.isArray(value))
    return value.map((item) => fillTemplate(item, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillTemplate(item, vars)]));
  }
  return value;
};
var replyText = (reply, chat) => {
  if (!reply || typeof reply !== "object" || !("choices" in reply))
    return;
  if (!Array.isArray(reply.choices))
    return;
  const choice = reply.choices[0];
  if (!choice || typeof choice !== "object")
    return;
  if (!chat)
    return "text" in choice ? choice.text : undefined;
  const message = "message" in choice ? choice.message : undefined;
  return message && typeof message === "object" && "content" in message ? message.content : undefined;
};
var requestTranslation = async (text, translator, post, signal) => {
  const vars = { text, source_lang: sourceLang(text) };
  const request = {
    ...translator.model === undefined ? {} : { model: translator.model },
    temperature: 0,
    max_tokens: MAX_TOKENS,
    ...translator.stop === undefined ? {} : { stop: translator.stop },
    ...translator.prompt === undefined ? { messages: translator.messages } : { prompt: translator.prompt },
    ...translator.body
  };
  const reply = await post(translator.url, JSON.stringify(fillTemplate(request, vars)), signal);
  if (reply.status < 200 || reply.status >= 300) {
    throw new Error(`${translator.url} answered HTTP ${reply.status}: ${reply.text.slice(0, 200)}`);
  }
  const out = replyText(JSON.parse(reply.text), translator.prompt === undefined);
  if (typeof out !== "string")
    throw new Error(`${translator.url} replied without text`);
  return out;
};

// src/core/block.ts
var DEFAULT_CHUNK_CHARS = 4000;
var DEFAULT_CONCURRENCY = 3;
var translatorAttempts = (translators, post) => translators.map((translator) => (chunk, signal) => requestTranslation(chunk, translator, post, signal));
var chunkPlan = (translators) => ({
  chunkChars: translators[0]?.chunkChars ?? DEFAULT_CHUNK_CHARS,
  concurrency: translators[0]?.concurrency ?? DEFAULT_CONCURRENCY
});
var translateBlock = async (text, options) => {
  const chunks = splitChunks(text, options.chunkChars);
  const parts = [];
  let next = 0;
  let abandoned = false;
  let failure;
  const translateChunk = async (chunk) => {
    const key = hashText(chunk);
    const cached = options.cache?.get(key);
    if (cached !== undefined)
      return cached;
    let lastError = new Error("no translator configured");
    for (const [index, attempt] of options.attempts.entries()) {
      if (options.signal.aborted || options.active?.() === false)
        return;
      try {
        const ja = (await attempt(chunk, options.signal)).trim();
        if (!ja)
          throw new Error("empty translation");
        options.cache?.set(key, ja);
        return ja;
      } catch (error) {
        lastError = error;
        options.onAttemptError?.(error, index + 1);
      }
    }
    throw lastError;
  };
  const worker = async () => {
    while (!abandoned && !failure && next < chunks.length) {
      const index = next++;
      const chunk = chunks[index];
      if (chunk === undefined)
        break;
      try {
        const ja = await translateChunk(chunk);
        if (ja === undefined)
          abandoned = true;
        else
          parts[index] = ja;
      } catch (error) {
        failure = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, chunks.length) }, worker));
  if (abandoned)
    return;
  if (failure)
    throw failure.error;
  return parts.join(`
`);
};

// src/core/http.ts
var REQUEST_TIMEOUT_MS = 60000;
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
  "plamo-3-translate": {
    prompt: "<|plamo:tag|>dataset<|plamo:msg|>translation" + "<|plamo:tag|>context<|plamo:msg|>Internal reasoning notes of an AI coding assistant working in a software repository. Code identifiers, commands and file paths stay as written." + "<|plamo:tag|>input<|plamo:msg|>{{text}}" + "<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>plain<|plamo:msg|>",
    stop: ["<|plamo:tag|>", "<|plamo:bos|>"],
    chunkChars: 1500,
    concurrency: 8
  },
  "hy-mt": {
    messages: [
      {
        role: "user",
        content: `Translate the following segment into Japanese, without additional explanation.

{{text}}`
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
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    throw new Error(`${at} must be an object`);
  const fields = new Map(Object.entries(entry));
  const presetName = fields.get("preset");
  let preset = {};
  if (presetName !== undefined) {
    const found = typeof presetName === "string" ? PRESETS[presetName] : undefined;
    if (!found)
      throw new Error(`${at}.preset must be one of: ${Object.keys(PRESETS).join(", ")}`);
    preset = found;
  }
  const url = fields.get("url");
  if (typeof url !== "string" || !url)
    throw new Error(`${at}.url must be a URL string`);
  const ownShape = fields.has("prompt") || fields.has("messages");
  const prompt = ownShape ? fields.get("prompt") : preset.prompt;
  const messages = ownShape ? fields.get("messages") : preset.messages;
  if (prompt !== undefined && typeof prompt !== "string")
    throw new Error(`${at}.prompt must be a string`);
  if (messages !== undefined && !Array.isArray(messages))
    throw new Error(`${at}.messages must be an array`);
  if (prompt === undefined === (messages === undefined)) {
    throw new Error(`${at} needs exactly one of prompt or messages (or a preset)`);
  }
  if (!JSON.stringify(prompt ?? messages).includes("{{text}}")) {
    throw new Error(`${at}.prompt or messages must contain {{text}}`);
  }
  const model = fields.get("model");
  if (model !== undefined && typeof model !== "string")
    throw new Error(`${at}.model must be a string`);
  const stop = fields.has("stop") ? fields.get("stop") : preset.stop;
  if (stop !== undefined && !isStringArray(stop))
    throw new Error(`${at}.stop must be an array of strings`);
  const ownBody = fields.get("body");
  if (ownBody !== undefined && (!ownBody || typeof ownBody !== "object" || Array.isArray(ownBody))) {
    throw new Error(`${at}.body must be an object`);
  }
  const body = preset.body || ownBody ? { ...preset.body, ...ownBody ? Object.fromEntries(Object.entries(ownBody)) : {} } : undefined;
  const count = (key) => {
    const value = fields.has(key) ? fields.get(key) : preset[key];
    if (value === undefined)
      return;
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
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  return parseConfig(JSON.parse(raw));
};

// src/viewer/watch.ts
import { open, stat as stat2 } from "node:fs/promises";

// src/viewer/sources.ts
import { readdir, readFile as readFile2, stat } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join2, relative } from "node:path";
import { zstdDecompressSync } from "node:zlib";
var fieldsOf = (value) => new Map(value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : []);
var contentArray = (message) => {
  const content = message.get("content");
  return Array.isArray(content) ? content : [];
};
var textBlocks = (content, kind, textKey, idPrefix) => content.flatMap((block, index) => {
  const fields = fieldsOf(block);
  const text = fields.get(textKey);
  return fields.get("type") === kind && typeof text === "string" && text.trim() ? [{ id: `${idPrefix}:${index}`, text: text.trim() }] : [];
});
var newestJsonl = async (dir, keep = () => true) => {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  let best;
  for (const name of names) {
    if (!name.endsWith(".jsonl") || !keep(name))
      continue;
    const path = join2(dir, name);
    const { mtimeMs } = await stat(path);
    if (!best || mtimeMs > best.mtime)
      best = { path, mtime: mtimeMs };
  }
  return best?.path;
};
var home = (env) => env.HOME || homedir2();
var claude = {
  name: "claude",
  find: (cwd, env) => newestJsonl(join2(env.CLAUDE_CONFIG_DIR || join2(home(env), ".claude"), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")), (name) => !name.startsWith(".")),
  blocks: (record) => {
    const fields = fieldsOf(record);
    if (fields.get("type") !== "assistant")
      return [];
    return textBlocks(contentArray(fieldsOf(fields.get("message"))), "thinking", "thinking", String(fields.get("uuid")));
  }
};
var codex = {
  name: "codex",
  find: async (cwd, env) => {
    const root = join2(env.CODEX_HOME || join2(home(env), ".codex"), "sessions");
    const descend = async (dir) => {
      try {
        return (await readdir(dir)).sort().reverse().map((name) => join2(dir, name));
      } catch {
        return [];
      }
    };
    let checked = 0;
    for (const year of await descend(root)) {
      for (const month of await descend(year)) {
        for (const day of await descend(month)) {
          const files = (await descend(day)).filter((path) => path.endsWith(".jsonl"));
          const dated = await Promise.all(files.map(async (path) => ({ path, mtime: (await stat(path)).mtimeMs })));
          for (const { path } of dated.sort((a, b) => b.mtime - a.mtime)) {
            if (++checked > 200)
              return;
            const first = (await readFile2(path, "utf8")).split(`
`, 1)[0] ?? "";
            try {
              if (fieldsOf(fieldsOf(JSON.parse(first)).get("payload")).get("cwd") === cwd)
                return path;
            } catch {}
          }
        }
      }
    }
    return;
  },
  blocks: (record) => {
    const fields = fieldsOf(record);
    const payload = fieldsOf(fields.get("payload"));
    if (fields.get("type") !== "response_item" || payload.get("type") !== "reasoning")
      return [];
    const parts = [payload.get("summary"), payload.get("content")].flatMap((list) => Array.isArray(list) ? list.map((part) => fieldsOf(part).get("text")) : []);
    const text = parts.filter((part) => typeof part === "string" && part.trim() !== "").join(`

`).trim();
    return text ? [{ id: String(payload.get("id")), text }] : [];
  }
};
var piBlocks = (record) => {
  const fields = fieldsOf(record);
  const message = fieldsOf(fields.get("message"));
  if (fields.get("type") !== "message" || message.get("role") !== "assistant")
    return [];
  return textBlocks(contentArray(message), "thinking", "thinking", String(fields.get("id")));
};
var pi = {
  name: "pi",
  find: (cwd, env) => newestJsonl(join2(env.PI_CODING_AGENT_DIR || join2(home(env), ".pi", "agent"), "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`)),
  blocks: piBlocks
};
var omp = {
  name: "omp",
  find: (cwd, env) => {
    const fromHome = relative(home(env), cwd);
    const key = fromHome.startsWith("..") ? cwd.replace(/\//g, "-") : `-${fromHome.replace(/\//g, "-")}`;
    return newestJsonl(join2(env.PI_CODING_AGENT_DIR || join2(home(env), ".omp", "agent"), "sessions", key));
  },
  blocks: piBlocks
};
var dsh = {
  name: "dsh",
  find: async (cwd, env) => {
    const dir = join2(env.DSH_HOME || join2(home(env), ".dsh"), "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
    let sessions;
    try {
      sessions = await readdir(dir);
    } catch {
      return;
    }
    let best;
    for (const session of sessions) {
      let names;
      try {
        names = await readdir(join2(dir, session));
      } catch {
        continue;
      }
      for (const name of names) {
        const generation = /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(name)?.[1];
        if (generation === undefined)
          continue;
        const path = join2(dir, session, name);
        const { mtimeMs } = await stat(path);
        const g = Number(generation);
        if (!best || mtimeMs > best.mtime || mtimeMs === best.mtime && g > best.generation) {
          best = { path, mtime: mtimeMs, generation: g };
        }
      }
    }
    return best?.path;
  },
  blocks: (record, line) => {
    const fields = fieldsOf(record);
    if (fields.get("type") !== "assistant/message")
      return [];
    const message = fieldsOf(fieldsOf(fields.get("data")).get("message"));
    const id = String(message.get("id") ?? fields.get("seq") ?? line);
    return textBlocks(contentArray(message), "reasoning", "text", id);
  }
};
var SOURCES = { claude, codex, pi, omp, dsh };
var readTranscript = async (path) => {
  const bytes = await readFile2(path);
  return path.endsWith(".zstd") ? zstdDecompressSync(bytes).toString("utf8") : bytes.toString("utf8");
};

// src/viewer/watch.ts
var FIND_INTERVAL_MS = 5000;
var createFollower = (options) => {
  const seen = new Set;
  let cursor;
  let foundAt = Number.NEGATIVE_INFINITY;
  const dim = (text) => `\x1B[2m${text}\x1B[0m`;
  const show = async (block) => {
    const time = new Date().toLocaleTimeString("ja-JP", { hour12: false });
    options.write(dim(`── ${time} ${options.source.name} ──`));
    if (options.original)
      options.write(dim(block.text));
    try {
      const ja = await translateBlock(block.text, {
        attempts: options.attempts,
        chunkChars: options.chunkChars,
        concurrency: options.concurrency,
        signal: options.signal
      });
      if (ja !== undefined)
        options.write(plainText(ja));
    } catch (error) {
      options.write(`(翻訳に失敗しました: ${String(error)})`);
    }
  };
  const readNew = async () => {
    if (!cursor)
      return [];
    const size = (await stat2(cursor.path).catch(() => {
      return;
    }))?.size;
    if (size === undefined || size === cursor.size)
      return [];
    if (cursor.path.endsWith(".zstd") || size < cursor.offset) {
      cursor = { ...cursor, offset: 0, partial: "" };
      const text = await readTranscript(cursor.path);
      cursor.size = size;
      return text.split(`
`).filter((line) => line.trim());
    }
    const handle = await open(cursor.path, "r");
    try {
      const buffer = Buffer.alloc(size - cursor.offset);
      await handle.read(buffer, 0, buffer.length, cursor.offset);
      const text = cursor.partial + buffer.toString("utf8");
      const lines = text.split(`
`);
      cursor.partial = lines.pop() ?? "";
      cursor.offset = size;
      cursor.size = size;
      return lines.filter((line) => line.trim());
    } finally {
      await handle.close();
    }
  };
  const step = async () => {
    let path = options.file ?? cursor?.path;
    if (!options.file && Date.now() - foundAt >= FIND_INTERVAL_MS) {
      path = await options.source.find(options.cwd, options.env) ?? path;
      foundAt = Date.now();
    }
    const opened = path !== undefined && path !== cursor?.path;
    if (path !== undefined && opened) {
      cursor = { path, offset: 0, partial: "", size: -1 };
      options.write(dim(`── ${options.source.name}: ${path} ──`));
    }
    const fresh = [];
    for (const [index, line] of (await readNew()).entries()) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      for (const block of options.source.blocks(record, index)) {
        if (seen.has(block.id))
          continue;
        seen.add(block.id);
        if (shouldTranslate(block.text))
          fresh.push(block);
      }
    }
    const todo = opened ? fresh.slice(fresh.length - Math.min(options.backlog, fresh.length)) : fresh;
    for (const block of todo) {
      if (options.signal.aborted)
        return;
      await show(block);
    }
  };
  return { step };
};
var sleep = (ms, signal) => {
  const { promise, resolve } = Promise.withResolvers();
  const done = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
  return promise;
};
var follow = async (options, intervalMs = 500) => {
  const follower = createFollower(options);
  while (!options.signal.aborted) {
    await follower.step();
    await sleep(intervalMs, options.signal);
  }
};

// src/cli.ts
var USAGE = `thinking-ja: Japanese translations of coding-agent thinking, by a local translation model

Usage:
  thinking-ja watch <${Object.keys(SOURCES).join("|")}> [--cwd DIR] [--file PATH] [--backlog N] [--original]
      Follow the harness's transcript for DIR (default: the current directory)
      and print a translation of every new thinking block.
        --file PATH    follow this transcript instead of the newest one for DIR
        --backlog N    also translate the last N blocks already in the transcript
        --original     print the original text above each translation
  thinking-ja translate
      Translate stdin with the configured translators (checks the config).

Config: ${configPath()}`;
var main = async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      file: { type: "string" },
      backlog: { type: "string" },
      original: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false }
    }
  });
  const [command, harness] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  const config = await loadConfig();
  if (!config?.translators.length) {
    console.error(`thinking-ja: ${configPath()} に translators がありません。README の設定例を参照してください。`);
    process.exitCode = 1;
    return;
  }
  const attempts = translatorAttempts(config.translators, fetchPost);
  const controller = new AbortController;
  process.once("SIGINT", () => controller.abort());
  if (command === "translate") {
    const chunks = [];
    for await (const chunk of process.stdin)
      chunks.push(chunk);
    const ja = await translateBlock(Buffer.concat(chunks).toString("utf8").trim(), {
      attempts,
      ...chunkPlan(config.translators),
      signal: controller.signal
    });
    if (ja !== undefined)
      console.log(ja);
    return;
  }
  if (command === "watch") {
    const source = harness === undefined ? undefined : SOURCES[harness];
    if (!source) {
      console.error(`thinking-ja: watch needs one of: ${Object.keys(SOURCES).join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const backlog = Number(values.backlog ?? 0);
    await follow({
      source,
      attempts,
      ...chunkPlan(config.translators),
      file: values.file,
      cwd: values.cwd ?? process.cwd(),
      env: process.env,
      backlog: Number.isInteger(backlog) && backlog > 0 ? backlog : 0,
      original: values.original,
      write: (line) => console.log(line),
      signal: controller.signal
    });
    return;
  }
  console.error(USAGE);
  process.exitCode = 1;
};
await main();
