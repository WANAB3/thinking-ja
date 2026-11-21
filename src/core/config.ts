import { PRESETS } from "./presets.ts";

/*
 * Pure: no Node.js imports, so sandboxed hosts (Claude Code mods) can parse a
 * config they read through their own file API. `load.ts` reads it from disk.
 */

/** Everything a translator entry may set besides its endpoint; what a preset provides. */
export type TranslatorTemplate = {
	/** Completions request body `prompt`; the reply is `choices[0].text`. */
	prompt?: string;
	/** Chat request body `messages`; the reply is `choices[0].message.content`. */
	messages?: unknown[];
	stop?: string[];
	/** Extra request fields (sampling, `chat_template_kwargs`, ...), merged last. */
	body?: Record<string, unknown>;
	/** Longest chunk one request carries; the first translator's value decides the split. */
	chunkChars?: number;
	/** Chunks of one block in flight at once; the first translator's value applies. */
	concurrency?: number;
};

/**
 * One OpenAI-compatible endpoint serving translation weights. Every string in
 * `prompt`, `messages` and `body` has `{{text}}` replaced by the chunk and
 * `{{source_lang}}` by `zh` or `en`.
 */
export type Translator = TranslatorTemplate & {
	/** Full endpoint URL, e.g. `http://127.0.0.1:8095/v1/completions`. */
	url: string;
	model?: string;
};

/** `translators` are tried in order for each chunk until one answers. */
export type Config = { translators: Translator[] };

export const parseConfig = (value: unknown): Config => {
	if (!value || typeof value !== "object" || !("translators" in value) || !Array.isArray(value.translators)) {
		throw new Error("config needs a translators array");
	}
	return {
		translators: value.translators.map((entry: unknown, index) => parseTranslator(entry, `translators[${index}]`)),
	};
};

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

const parseTranslator = (entry: unknown, at: string): Translator => {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${at} must be an object`);
	const fields = new Map<string, unknown>(Object.entries(entry));

	const presetName = fields.get("preset");
	let preset: TranslatorTemplate = {};
	if (presetName !== undefined) {
		const found = typeof presetName === "string" ? PRESETS[presetName] : undefined;
		if (!found) throw new Error(`${at}.preset must be one of: ${Object.keys(PRESETS).join(", ")}`);
		preset = found;
	}

	const url = fields.get("url");
	if (typeof url !== "string" || !url) throw new Error(`${at}.url must be a URL string`);

	// An entry that brings its own prompt or messages replaces the preset's request shape.
	const ownShape = fields.has("prompt") || fields.has("messages");
	const prompt = ownShape ? fields.get("prompt") : preset.prompt;
	const messages = ownShape ? fields.get("messages") : preset.messages;
	if (prompt !== undefined && typeof prompt !== "string") throw new Error(`${at}.prompt must be a string`);
	if (messages !== undefined && !Array.isArray(messages)) throw new Error(`${at}.messages must be an array`);
	if ((prompt === undefined) === (messages === undefined)) {
		throw new Error(`${at} needs exactly one of prompt or messages (or a preset)`);
	}
	if (!JSON.stringify(prompt ?? messages).includes("{{text}}")) {
		throw new Error(`${at}.prompt or messages must contain {{text}}`);
	}

	const model = fields.get("model");
	if (model !== undefined && typeof model !== "string") throw new Error(`${at}.model must be a string`);

	const stop = fields.has("stop") ? fields.get("stop") : preset.stop;
	if (stop !== undefined && !isStringArray(stop)) throw new Error(`${at}.stop must be an array of strings`);

	const ownBody = fields.get("body");
	if (ownBody !== undefined && (!ownBody || typeof ownBody !== "object" || Array.isArray(ownBody))) {
		throw new Error(`${at}.body must be an object`);
	}
	const body =
		preset.body || ownBody ? { ...preset.body, ...(ownBody ? Object.fromEntries(Object.entries(ownBody)) : {}) } : undefined;

	const count = (key: "chunkChars" | "concurrency"): number | undefined => {
		const value = fields.has(key) ? fields.get(key) : preset[key];
		if (value === undefined) return undefined;
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
		concurrency: count("concurrency"),
	};
};
