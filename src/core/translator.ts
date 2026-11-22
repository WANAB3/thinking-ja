import type { Translator } from "./config.ts";
import { sourceLang } from "./text.ts";

/*
 * Pure: the HTTP call is injected, because sandboxed hosts (Claude Code mods)
 * have no global fetch and must use their own. `http.ts` has the fetch one.
 */

/** POSTs a JSON body and resolves to the reply status and body text. */
export type HttpPost = (url: string, body: string, signal?: AbortSignal) => Promise<{ status: number; text: string }>;

/** Generation cap for one chunk; a translator's `body.max_tokens` overrides it. */
const MAX_TOKENS = 4096;

type TemplateVars = Record<"text" | "source_lang", string>;

/**
 * Replaces `{{text}}` and `{{source_lang}}` in every string of a JSON-shaped
 * template, one pass per string, so placeholders inside the chunk itself are
 * never expanded.
 */
const fillTemplate = (value: unknown, vars: TemplateVars): unknown => {
	if (typeof value === "string") {
		return value.replace(/\{\{(text|source_lang)\}\}/g, (_match, key: keyof TemplateVars) => vars[key]);
	}
	if (Array.isArray(value)) return value.map((item) => fillTemplate(item, vars));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillTemplate(item, vars)]));
	}
	return value;
};

/** `choices[0].message.content` of a chat reply, or `choices[0].text` of a completions reply. */
const replyText = (reply: unknown, chat: boolean, requireComplete: boolean): unknown => {
	if (!reply || typeof reply !== "object") return undefined;
	if (requireComplete && "error" in reply && reply.error != null) {
		throw new Error(`translation error: ${JSON.stringify(reply.error).slice(0, 200)}`);
	}
	if (!("choices" in reply)) return undefined;
	if (!Array.isArray(reply.choices)) return undefined;
	const choice: unknown = reply.choices[0];
	if (!choice || typeof choice !== "object") return undefined;
	if (requireComplete && "finish_reason" in choice && choice.finish_reason != null && choice.finish_reason !== "stop") {
		throw new Error(`translation ended with ${String(choice.finish_reason)}`);
	}
	if (!chat) return "text" in choice ? choice.text : undefined;
	const message = "message" in choice ? choice.message : undefined;
	return message && typeof message === "object" && "content" in message ? message.content : undefined;
};

/** Builds the shared request body without choosing a transport. */
export const translationRequestBody = (text: string, translator: Translator): Record<string, unknown> => {
	const vars: TemplateVars = { text, source_lang: sourceLang(text) };
	const request = {
		...(translator.model === undefined ? {} : { model: translator.model }),
		temperature: 0,
		max_tokens: MAX_TOKENS,
		...(translator.stop === undefined ? {} : { stop: translator.stop }),
		...(translator.prompt === undefined ? { messages: translator.messages } : { prompt: translator.prompt }),
		...translator.body,
	};
	return fillTemplate(request, vars) as Record<string, unknown>;
};

/** Validates an HTTP reply and extracts only the requested translation text. */
export const translationReplyText = (
	reply: { status: number; text: string },
	translator: Translator,
	options?: { requireComplete: boolean },
): string => {
	if (reply.status < 200 || reply.status >= 300) {
		throw new Error(`${translator.url} answered HTTP ${reply.status}: ${reply.text.slice(0, 200)}`);
	}
	const out = replyText(JSON.parse(reply.text), translator.prompt === undefined, options?.requireComplete ?? false);
	if (typeof out !== "string") throw new Error(`${translator.url} replied without text`);
	return out;
};

/**
 * One chunk through one translator: the bare text, verbatim, inside the
 * translator's own template, with no instructions around it.
 */
export const requestTranslation = async (
	text: string,
	translator: Translator,
	post: HttpPost,
	signal?: AbortSignal,
): Promise<string> =>
	translationReplyText(await post(translator.url, JSON.stringify(translationRequestBody(text, translator)), signal), translator);
