import type { Translator } from "./config.ts";
import { type HttpPost, translationReplyText, translationRequestBody } from "./translator.ts";

/** Deadline for one translation request. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** `HttpPost` over the global `fetch` (Node, Bun, browsers), with REQUEST_TIMEOUT_MS. */
export const fetchPost: HttpPost = async (url, body, signal) => {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	return { status: response.status, text: await response.text() };
};

/** Only an explicit rejection of the stream option is safe to replay. */
const rejectsStreaming = (status: number, text: string): boolean => {
	if (status < 400 || status >= 500 || [401, 403, 408, 429].includes(status)) return false;
	const message = text.replace(/["'`]/g, "");
	return (
		/\bstream(?:ing)?\b(?:\s+(?:responses?|mode|flag|parameter|argument|field|option))?\s*[:=]?\s*(?:true\s+)?(?:(?:is|are|was)\s+)?(?:currently\s+)?(?:not\s+(?:supported|allowed|permitted)|unsupported|must\s+be\s+false|only\s+supports?\s+false)\b/i.test(message) ||
		/\b(?:unknown|unrecognized|unrecognised|unexpected|unsupported)\s+(?:(?:request|keyword)\s+)?(?:(?:parameter|argument|field|option|flag)\s*:?\s*)?stream(?:ing)?\b/i.test(message) ||
		/\b(?:not|doesnt|cannot|cant)\s+support\s+stream(?:ing)?\b/i.test(message)
	);
};

const readTranslationStream = async (
	response: Response,
	translator: Translator,
	signal: AbortSignal,
	onDelta: (delta: string) => void,
): Promise<string> => {
	if (!response.body) throw new Error(`${translator.url} replied without a stream`);
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const chat = translator.prompt === undefined;
	let pending = "";
	let data: string[] = [];
	let event = "";
	let output = "";
	let sawText = false;
	let stopped = false;
	let done = false;
	const invalid = (message: string): Error => new Error(`${translator.url}: ${message}`);

	const dispatch = (): void => {
		const name = event;
		event = "";
		if (data.length === 0) {
			if (name === "error") throw invalid("translation stream reported an error");
			return;
		}
		const raw = data.join("\n");
		data = [];
		if (name === "error") throw invalid(`translation stream error: ${raw.slice(0, 200)}`);
		if (raw.trim() === "[DONE]") {
			done = true;
			return;
		}
		let payload: unknown;
		try {
			payload = JSON.parse(raw);
		} catch {
			throw invalid("malformed JSON in translation stream");
		}
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw invalid("malformed translation stream frame");
		if ("error" in payload && payload.error != null) {
			throw invalid(`translation stream error: ${JSON.stringify(payload.error).slice(0, 200)}`);
		}
		if (!("choices" in payload) || !Array.isArray(payload.choices)) throw invalid("translation stream frame has no choices");
		// Usage-only frames have no choices; never inspect another choice's text.
		if (payload.choices.length === 0) return;
		const choice: unknown = payload.choices[0];
		if (!choice || typeof choice !== "object" || Array.isArray(choice)) throw invalid("malformed translation stream choice");
		const reason = "finish_reason" in choice ? choice.finish_reason : undefined;
		if (reason != null && reason !== "stop") throw invalid(`translation stream ended with ${String(reason)}`);
		let delta: unknown;
		if (chat) {
			const value = "delta" in choice ? choice.delta : undefined;
			if (value != null && (typeof value !== "object" || Array.isArray(value))) throw invalid("malformed translation stream delta");
			if (value == null && reason == null) throw invalid("translation stream choice has no delta");
			delta = value && typeof value === "object" && "content" in value ? value.content : undefined;
		} else {
			if (!("text" in choice) && reason == null) throw invalid("translation stream choice has no text");
			delta = "text" in choice ? choice.text : undefined;
		}
		if (delta != null && typeof delta !== "string") throw invalid("translation stream text is not a string");
		if (typeof delta === "string") {
			sawText = true;
			if (delta) {
				if (stopped) throw invalid("translation stream continued after its finish");
				output += delta;
				onDelta(delta);
			}
		}
		if (reason === "stop") stopped = true;
	};

	const line = (value: string): void => {
		if (value.endsWith("\r")) value = value.slice(0, -1);
		if (!value) {
			dispatch();
			return;
		}
		if (value.startsWith(":")) return;
		const colon = value.indexOf(":");
		const field = colon < 0 ? value : value.slice(0, colon);
		let content = colon < 0 ? "" : value.slice(colon + 1);
		if (content.startsWith(" ")) content = content.slice(1);
		if (field === "data") data.push(content);
		else if (field === "event") event = content;
	};

	const consume = (text: string): void => {
		pending += text;
		let start = 0;
		let end: number;
		while (!done && (end = pending.indexOf("\n", start)) !== -1) {
			line(pending.slice(start, end));
			start = end + 1;
		}
		pending = pending.slice(start);
	};

	const abort = (): void => {
		void reader.cancel(signal.reason).catch(() => { });
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		while (!done) {
			signal.throwIfAborted();
			const chunk = await reader.read();
			signal.throwIfAborted();
			if (chunk.done) {
				consume(decoder.decode());
				if (pending) line(pending);
				if (data.length > 0 || (!done && !stopped)) throw invalid("truncated translation stream");
				break;
			}
			consume(decoder.decode(chunk.value, { stream: true }));
		}
		signal.throwIfAborted();
		if (!sawText) throw invalid("translation stream replied without text");
		return output;
	} catch (error) {
		signal.throwIfAborted();
		throw error;
	} finally {
		signal.removeEventListener("abort", abort);
		void reader.cancel().catch(() => { });
		reader.releaseLock();
	}
};

/**
 * Streams only translation text, resolving after a clean finish. Explicit
 * `body.stream: false` and servers returning ordinary JSON keep working.
 * Only a rejected stream option may be retried, before any SSE body is read.
 */
export const requestStreamingTranslation = async (
	text: string,
	translator: Translator,
	signal: AbortSignal,
	onDelta: (delta: string) => void,
): Promise<string> => {
	const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
	requestSignal.throwIfAborted();
	const body = translationRequestBody(text, translator);
	const streaming = body.stream !== false;
	if (streaming) body.stream = true;
	const post = (): Promise<Response> =>
		fetch(translator.url, {
			method: "POST",
			// A 307/308 must not forward the original notes to an unconfigured URL.
			redirect: "manual",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: requestSignal,
		});
	let response = await post();
	requestSignal.throwIfAborted();
	const isSse = (reply: Response): boolean =>
		reply.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
	if (response.ok && isSse(response)) return readTranslationStream(response, translator, requestSignal, onDelta);
	let reply = { status: response.status, text: await response.text() };
	requestSignal.throwIfAborted();
	if (streaming && !isSse(response) && rejectsStreaming(reply.status, reply.text)) {
		// Omit the option entirely: servers with no stream parameter can reject false too.
		delete body.stream;
		response = await post();
		requestSignal.throwIfAborted();
		if (response.ok && isSse(response)) return readTranslationStream(response, translator, requestSignal, onDelta);
		reply = { status: response.status, text: await response.text() };
		requestSignal.throwIfAborted();
	}
	const output = translationReplyText(reply, translator, { requireComplete: true });
	if (output) onDelta(output);
	requestSignal.throwIfAborted();
	return output;
};
