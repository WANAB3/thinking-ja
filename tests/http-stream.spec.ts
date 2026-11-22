import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Translator } from "../src/core/config.ts";
import { REQUEST_TIMEOUT_MS, requestStreamingTranslation } from "../src/core/http.ts";

const chat: Translator = {
	url: "http://translation.invalid/v1/chat/completions",
	messages: [{ role: "user", content: "{{source_lang}}: {{text}}" }],
};
const completion: Translator = {
	url: "http://translation.invalid/v1/completions",
	prompt: "{{source_lang}}: {{text}}",
};
const encoder = new TextEncoder();
const controllers: AbortController[] = [];

const cancellation = (): AbortController => {
	const controller = new AbortController();
	controllers.push(controller);
	return controller;
};

const stream = () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const cancelled = Promise.withResolvers<unknown>();
	const body = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
		},
		cancel(reason) {
			cancelled.resolve(reason);
		},
	});
	return {
		response: new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } }),
		push(value: string | Uint8Array) {
			controller.enqueue(typeof value === "string" ? encoder.encode(value) : value);
		},
		close() {
			controller.close();
		},
		fail(error: Error) {
			controller.error(error);
		},
		cancelled: cancelled.promise,
	};
};

const respond = (...responses: Response[]) => {
	let index = 0;
	const implementation = Object.assign(async () => {
		const response = responses[index++];
		if (!response) throw new Error("Unexpected translation retry");
		return response;
	}, { preconnect: globalThis.fetch.preconnect });
	return spyOn(globalThis, "fetch").mockImplementation(implementation);
};

const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const partial = frame({ choices: [{ delta: { content: "途中" } }] });
const stop = frame({ choices: [{ delta: {}, finish_reason: "stop" }] });
const done = "data: [DONE]\n\n";

afterEach(() => {
	for (const controller of controllers) controller.abort();
	controllers.length = 0;
	mock.restore();
});

describe("requestStreamingTranslation", () => {
	test("emits real chat fragments before completion across UTF-8 and CRLF boundaries", async () => {
		const source = stream();
		const fetch = respond(source.response);
		const seen = Promise.withResolvers<void>();
		const deltas: string[] = [];
		let settled = false;
		const result = requestStreamingTranslation("Translate this {{text}}.", chat, cancellation().signal, (delta) => {
			deltas.push(delta);
			seen.resolve();
		}).then((value) => {
			settled = true;
			return value;
		});
		const first =
			": keepalive\r\nid: 4\r\nretry: 100\r\n\r\n" +
			frame({ choices: [{ delta: { role: "assistant", content: null } }] }) +
			frame({ choices: [{ delta: { reasoning_content: "private reasoning" } }] }) +
			"data: {\"choices\": [\r\ndata: {\"delta\":{\"content\":\"日本\"}}, {\"delta\":{\"content\":\"除外\"}}]}\r\n\r\n";
		// Every Japanese character and CRLF delimiter crosses read boundaries.
		for (const byte of encoder.encode(first)) source.push(new Uint8Array([byte]));
		await seen.promise;
		expect(deltas).toEqual(["日本"]);
		expect(settled).toBe(false);
		const sent = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
		expect(sent).toMatchObject({ stream: true, messages: [{ role: "user", content: "en: Translate this {{text}}." }] });
		source.push(frame({ choices: [{ delta: { content: "語です。", reasoning_content: "not translation" } }] }));
		source.push(stop);
		source.push(frame({ choices: [], usage: { completion_tokens: 5 } }));
		source.push(done);
		// The server need not close its connection after the protocol terminator.
		expect(await result).toBe("日本語です。");
		expect(deltas).toEqual(["日本", "語です。"]);
		await source.cancelled;
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("streams completions choices[0].text and accepts a clean stop followed by EOF", async () => {
		const source = stream();
		const fetch = respond(source.response);
		const first = Promise.withResolvers<void>();
		const deltas: string[] = [];
		const translator: Translator = {
			...completion,
			model: "configured-model",
			stop: ["<end>"],
			body: { temperature: 0.6, max_tokens: 500, nested: { source: "{{source_lang}}", text: "{{text}}" } },
		};
		const result = requestStreamingTranslation("Keep **kwargs and {{source_lang}}.", translator, cancellation().signal, (delta) => {
			deltas.push(delta);
			first.resolve();
		});
		source.push(frame({ choices: [{ text: "全", reasoning_content: "ignored" }, { text: "ignored" }] }));
		await first.promise;
		expect(deltas).toEqual(["全"]);
		source.push(frame({ choices: [{ text: "文", finish_reason: "stop" }] }));
		source.close();
		expect(await result).toBe("全文");
		expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
			stream: true,
			model: "configured-model",
			prompt: "en: Keep **kwargs and {{source_lang}}.",
			stop: ["<end>"],
			temperature: 0.6,
			max_tokens: 500,
			nested: { source: "en", text: "Keep **kwargs and {{source_lang}}." },
		});
	});

	test("accepts DONE as the clean terminator without a separate finish-reason frame", async () => {
		const source = stream();
		respond(source.response);
		const deltas: string[] = [];
		const result = requestStreamingTranslation("Translate this.", chat, cancellation().signal, (delta) => deltas.push(delta));
		source.push(partial + done);
		expect(await result).toBe("途中");
		expect(deltas).toEqual(["途中"]);
	});

	for (const translator of [chat, completion]) {
		test.each([undefined, false])(`accepts ordinary JSON for ${translator.prompt === undefined ? "chat" : "completions"}, stream=%s`, async (setting) => {
			const response = translator.prompt === undefined
				? { choices: [{ message: { content: "全文", reasoning_content: "ignored" } }, { message: { content: "ignored" } }] }
				: { choices: [{ text: "全文" }, { text: "ignored" }] };
			const fetch = respond(Response.json(response));
			const deltas: string[] = [];
			const configured = { ...translator, body: setting === undefined ? undefined : { stream: setting } };
			expect(await requestStreamingTranslation("Translate this.", configured, cancellation().signal, (delta) => deltas.push(delta))).toBe("全文");
			expect(deltas).toEqual(["全文"]);
			expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).stream).toBe(setting ?? true);
			expect(fetch).toHaveBeenCalledTimes(1);
		});
	}

	test.each([
		[400, "Streaming is not supported"],
		[422, "Unknown parameter: 'stream'"],
		[400, "Unexpected keyword argument 'stream'"],
		[400, "stream must be false"],
	])("retries only a rejected stream option as normal JSON (%s, %s)", async (status, message) => {
		const fetch = respond(Response.json({ error: { message } }, { status }), Response.json({ choices: [{ message: { content: "全訳" } }] }));
		const deltas: string[] = [];
		expect(await requestStreamingTranslation("Translate {{text}}.", chat, cancellation().signal, (delta) => deltas.push(delta))).toBe("全訳");
		expect(deltas).toEqual(["全訳"]);
		expect(fetch).toHaveBeenCalledTimes(2);
		const first = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
		const fallback = JSON.parse(fetch.mock.calls[1]![1]!.body as string);
		expect(first.stream).toBe(true);
		expect(fallback).not.toHaveProperty("stream");
		const { stream: _stream, ...normal } = first;
		expect(fallback).toEqual(normal);
		expect(fetch.mock.calls[1]![1]!.signal).toBe(fetch.mock.calls[0]![1]!.signal);
	});

	test.each([
		[400, "Invalid model"],
		[400, "Invalid stream value"],
		[400, "Unsupported model for a stream request"],
		[429, "Streaming is not supported while rate limited"],
		[503, "Streaming is not supported during downtime"],
	])("does not retry an unrelated or potentially billed HTTP failure (%s, %s)", async (status, message) => {
		const fetch = respond(Response.json({ error: { message } }, { status }));
		const deltas: string[] = [];
		await expect(requestStreamingTranslation("Translate this.", chat, cancellation().signal, (delta) => deltas.push(delta))).rejects.toThrow(`HTTP ${status}`);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(deltas).toEqual([]);
	});

	test("does not retry a stream-option error when streaming was explicitly disabled", async () => {
		const fetch = respond(Response.json({ error: { message: "Unknown parameter: stream" } }, { status: 400 }));
		await expect(requestStreamingTranslation("Translate this.", { ...chat, body: { stream: false } }, cancellation().signal, () => { })).rejects.toThrow("HTTP 400");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("does not replay an HTTP error carrying an SSE body", async () => {
		const fetch = respond(new Response("event: error\ndata: streaming is not supported\n\n", {
			status: 400,
			headers: { "content-type": "text/event-stream" },
		}));
		await expect(requestStreamingTranslation("Translate this.", chat, cancellation().signal, () => { })).rejects.toThrow("HTTP 400");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("limits a rejected fallback to one retry", async () => {
		const rejection = () => Response.json({ error: { message: "streaming is not supported" } }, { status: 400 });
		const fetch = respond(rejection(), rejection());
		await expect(requestStreamingTranslation("Translate this.", chat, cancellation().signal, () => { })).rejects.toThrow("HTTP 400");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test.each([
		["malformed JSON", "data: {bad}\n\n", "malformed JSON"],
		["error payload", frame({ error: { message: "streaming is not supported" } }), "stream error"],
		["error event", "event: error\ndata: streaming is not supported\n\n", "stream error"],
		["non-string text", frame({ choices: [{ delta: { content: 123 } }] }), "not a string"],
		["token limit", frame({ choices: [{ delta: {}, finish_reason: "length" }] }) + done, "ended with length"],
		["filtered output", frame({ choices: [{ delta: {}, finish_reason: "content_filter" }] }) + done, "ended with content_filter"],
		["invalid delta", frame({ choices: [{ delta: "invalid" }] }), "malformed translation stream delta"],
		["missing delta", frame({ choices: [{}] }), "no delta"],
		["missing choices", frame({ unexpected: "frame" }), "no choices"],
		["unfinished event", "data: {\"choices\":[", "truncated"],
		["missing terminator", "", "truncated"],
		["unfinished final event", stop + "data: [DONE]", "truncated"],
		["late malformed event", stop + "data: {bad}\n\n", "malformed JSON"],
		["text after finish", stop + partial, "continued after its finish"],
	])("rejects %s after a visible partial without returning or retrying it", async (_name, suffix, error) => {
		const source = stream();
		const fetch = respond(source.response);
		const deltas: string[] = [];
		const result = requestStreamingTranslation("Translate this.", chat, cancellation().signal, (delta) => deltas.push(delta));
		source.push(partial + suffix);
		source.close();
		await expect(result).rejects.toThrow(error);
		expect(deltas).toEqual(["途中"]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("rejects incomplete UTF-8 instead of inserting a replacement character", async () => {
		const source = stream();
		respond(source.response);
		const deltas: string[] = [];
		const result = requestStreamingTranslation("Translate this.", chat, cancellation().signal, (delta) => deltas.push(delta));
		source.push(partial + stop);
		source.push(new Uint8Array([0xe6, 0x97]));
		source.close();
		await expect(result).rejects.toThrow();
		expect(deltas).toEqual(["途中"]);
	});

	test("rejects a transport failure after delivering a visible partial", async () => {
		const source = stream();
		const fetch = respond(source.response);
		const seen = Promise.withResolvers<void>();
		const failure = new Error("Connection reset");
		const result = requestStreamingTranslation("Translate this.", chat, cancellation().signal, () => seen.resolve());
		source.push(partial);
		await seen.promise;
		source.fail(failure);
		await expect(result).rejects.toBe(failure);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("propagates cancellation while waiting for the next fragment", async () => {
		const source = stream();
		const fetch = respond(source.response);
		const controller = cancellation();
		const seen = Promise.withResolvers<void>();
		const deltas: string[] = [];
		const result = requestStreamingTranslation("Translate this.", chat, controller.signal, (delta) => {
			deltas.push(delta);
			seen.resolve();
		});
		source.push(partial);
		await seen.promise;
		const reason = new DOMException("Superseded thinking block", "AbortError");
		controller.abort(reason);
		await expect(result).rejects.toBe(reason);
		expect(await source.cancelled).toBe(reason);
		expect(deltas).toEqual(["途中"]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("does not start a request that was already cancelled", async () => {
		const fetch = respond();
		const controller = cancellation();
		const reason = new DOMException("Cancelled", "AbortError");
		controller.abort(reason);
		await expect(requestStreamingTranslation("Translate this.", chat, controller.signal, () => { })).rejects.toBe(reason);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("applies the request deadline to a stalled response body", async () => {
		const source = stream();
		respond(source.response);
		const deadline = cancellation();
		const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
		const seen = Promise.withResolvers<void>();
		const result = requestStreamingTranslation("Translate this.", chat, cancellation().signal, () => seen.resolve());
		source.push(partial);
		await seen.promise;
		const reason = new DOMException("Translation deadline exceeded", "TimeoutError");
		deadline.abort(reason);
		await expect(result).rejects.toBe(reason);
		expect(await source.cancelled).toBe(reason);
		expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
	});

	test("rejects ordinary JSON errors without emitting or retrying", async () => {
		const fetch = respond(Response.json({ error: { message: "streaming is not supported" } }));
		const deltas: string[] = [];
		await expect(requestStreamingTranslation("Translate this.", chat, cancellation().signal, (delta) => deltas.push(delta))).rejects.toThrow("translation error");
		expect(deltas).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test.each([chat, completion])("rejects truncated ordinary JSON before emitting it (%j)", async (translator) => {
		const choice = translator.prompt === undefined
			? { message: { content: "不完全" }, finish_reason: "length" }
			: { text: "不完全", finish_reason: "length" };
		const fetch = respond(Response.json({ choices: [choice] }));
		const deltas: string[] = [];
		await expect(requestStreamingTranslation("Translate this.", translator, cancellation().signal, (delta) => deltas.push(delta))).rejects.toThrow("ended with length");
		expect(deltas).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
