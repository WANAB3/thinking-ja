import { afterAll, describe, expect, test } from "bun:test";
import { chunkPlan, translateBlock, translatorAttempts } from "../src/core/block.ts";
import { parseConfig } from "../src/core/config.ts";
import { fetchPost } from "../src/core/http.ts";
import { shouldTranslate, splitChunks, toLines } from "../src/core/text.ts";
import { requestTranslation } from "../src/core/translator.ts";

/** A fake OpenAI-compatible server: echoes `訳:` + the text it was asked to translate. */
const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
let failCompletions = false;
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		const body = (await request.json()) as Record<string, unknown>;
		requests.push({ path, body });
		if (path === "/v1/completions") {
			if (failCompletions) return new Response("down", { status: 503 });
			const prompt = String(body.prompt);
			return Response.json({ choices: [{ text: `訳:${prompt.slice(prompt.indexOf("[") + 1, prompt.indexOf("]"))}` }] });
		}
		const messages = body.messages as Array<{ content: string }>;
		return Response.json({ choices: [{ message: { content: `訳:${messages.at(-1)?.content.split("\n\n").at(-1)}` } }] });
	},
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;

describe("parseConfig", () => {
	test("a preset supplies the request shape and split plan; entry fields win", () => {
		const { translators } = parseConfig({
			translators: [{ preset: "plamo-3-translate", url: `${base}/v1/completions`, model: "plamo", concurrency: 4 }],
		});
		const plamo = translators[0]!;
		expect(plamo.prompt).toContain("{{text}}");
		expect(plamo.stop).toEqual(["<|plamo:tag|>", "<|plamo:bos|>"]);
		expect(chunkPlan(translators)).toEqual({ chunkChars: 1500, concurrency: 4 });
	});

	test("own messages replace a preset prompt, and body merges over the preset's", () => {
		const hy = parseConfig({
			translators: [{ preset: "hy-mt", url: "http://x/v1/chat/completions", body: { temperature: 0 } }],
		}).translators[0]!;
		expect(hy.body).toEqual({ temperature: 0, top_k: 20, top_p: 0.6, repeat_penalty: 1.05 });
		const own = parseConfig({
			translators: [{ preset: "plamo-3-translate", url: "http://x", messages: [{ role: "user", content: "{{text}}" }] }],
		}).translators[0]!;
		expect(own.prompt).toBeUndefined();
		expect(own.messages).toEqual([{ role: "user", content: "{{text}}" }]);
	});

	test.each([
		[{}, "config needs a translators array"],
		[{ translators: [{ prompt: "{{text}}" }] }, "translators[0].url must be a URL string"],
		[{ translators: [{ url: "http://x", prompt: "hello" }] }, "translators[0].prompt or messages must contain {{text}}"],
		[{ translators: [{ url: "http://x", prompt: "{{text}}", messages: [] }] }, "translators[0] needs exactly one of prompt or messages (or a preset)"],
		[{ translators: [{ url: "http://x", preset: "nope" }] }, "translators[0].preset must be one of: plamo-3-translate, hy-mt"],
		[{ translators: [{ url: "http://x", prompt: "{{text}}", concurrency: 0 }] }, "translators[0].concurrency must be a positive integer"],
	])("rejects %j", (config, message) => {
		expect(() => parseConfig(config)).toThrow(message);
	});
});

describe("text gates", () => {
	test("English and Chinese blocks are translated; Japanese and tiny ones are not", () => {
		expect(shouldTranslate("Checking whether the cache survives a resume.")).toBe(true);
		expect(shouldTranslate("检查缓存在恢复后是否仍然存在，然后再决定下一步。")).toBe(true);
		expect(shouldTranslate("キャッシュが再開後も残るかを確認してから次に進む。")).toBe(false);
		expect(shouldTranslate("**Reading**")).toBe(false);
	});

	test("plain-text views drop the markers of a bold heading line only", () => {
		const ja = ["**設定の読み込み**", "f(**kwargs) と a ** b、src/**/*.ts を確認する", "```", "**x**", "```"].join("\n");
		expect(toLines(ja)).toEqual(["設定の読み込み", "f(**kwargs) と a ** b、src/**/*.ts を確認する", "```", "**x**", "```"]);
	});

	test("appending to a block leaves every earlier chunk byte-identical", () => {
		const paragraph = (n: number) => `Paragraph ${n} ${"word ".repeat(60)}`.trim();
		const before = Array.from({ length: 6 }, (_, n) => paragraph(n)).join("\n\n");
		const after = `${before}\n\n${paragraph(6)}`;
		const a = splitChunks(before, 700);
		const b = splitChunks(after, 700);
		expect(a.length).toBeGreaterThan(1);
		expect(b.slice(0, a.length - 1)).toEqual(a.slice(0, -1));
		expect(b.every((chunk) => chunk.length <= 700)).toBe(true);
	});
});

describe("requestTranslation", () => {
	/** `**` in code, math and globs: all must reach the model untouched. */
	const CODE = "Pass **kwargs on, keep a ** b, glob src/**/*.ts";

	test("completions: fills the prompt once, sends the text verbatim and sets source_lang", async () => {
		const translator = parseConfig({
			translators: [{ url: `${base}/v1/completions`, prompt: "lang={{source_lang}} [{{text}}]", stop: ["<end>"] }],
		}).translators[0]!;
		const ja = await requestTranslation(`**Plan** ${CODE} {{text}}`, translator, fetchPost);
		expect(ja).toBe(`訳:**Plan** ${CODE} {{text}}`);
		const sent = requests.at(-1)!.body;
		expect(sent.prompt).toBe(`lang=en [**Plan** ${CODE} {{text}}]`);
		expect(sent).toMatchObject({ temperature: 0, stop: ["<end>"] });
	});

	test("chat: sends the text verbatim, reads message.content and merges the preset's sampling", async () => {
		const translator = parseConfig({
			translators: [{ preset: "hy-mt", url: `${base}/v1/chat/completions` }],
		}).translators[0]!;
		expect(await requestTranslation(CODE, translator, fetchPost)).toBe(`訳:${CODE}`);
		const sent = requests.at(-1)!.body as { messages: Array<{ content: string }> };
		expect(sent.messages.at(-1)!.content.endsWith(`\n\n${CODE}`)).toBe(true);
		expect(sent).toMatchObject({ temperature: 0.7, top_k: 20 });
	});

	test("an error status is reported with the endpoint and body", async () => {
		const translator = parseConfig({ translators: [{ url: `${base}/v1/completions`, prompt: "[{{text}}]" }] }).translators[0]!;
		failCompletions = true;
		try {
			await expect(requestTranslation("Anything at all here.", translator, fetchPost)).rejects.toThrow(
				`${base}/v1/completions answered HTTP 503: down`,
			);
		} finally {
			failCompletions = false;
		}
	});
});

describe("translateBlock", () => {
	const translators = parseConfig({
		translators: [
			{ url: `${base}/v1/completions`, prompt: "[{{text}}]", chunkChars: 40, concurrency: 2 },
			{ url: `${base}/v1/chat/completions`, messages: [{ role: "user", content: "{{text}}" }] },
		],
	}).translators;
	const text = "First sentence of the block. Second sentence follows. Third one ends it.";

	test("joins chunk translations in order, falling back to the next translator", async () => {
		failCompletions = true;
		let ja: string | undefined;
		try {
			ja = await translateBlock(text, {
				attempts: translatorAttempts(translators, fetchPost),
				...chunkPlan(translators),
				signal: new AbortController().signal,
			});
		} finally {
			failCompletions = false;
		}
		expect(ja).toBe(splitChunks(text, 40).map((chunk) => `訳:${chunk}`).join("\n"));
	});

	test("a cached chunk is not requested again", async () => {
		const cache = new Map<string, string>();
		const options = { attempts: translatorAttempts(translators, fetchPost), ...chunkPlan(translators), signal: new AbortController().signal, cache };
		await translateBlock(text, options);
		const sent = requests.length;
		expect(await translateBlock(text, options)).toContain("訳:First sentence");
		expect(requests.length).toBe(sent);
	});

	test("abandons when switched off, and rejects with the last error when every attempt fails", async () => {
		const attempts = [async () => { throw new Error("first"); }, async () => { throw new Error("last"); }];
		const options = { chunkChars: 40, concurrency: 2, signal: new AbortController().signal };
		expect(await translateBlock(text, { ...options, attempts, active: () => false })).toBeUndefined();
		expect(translateBlock(text, { ...options, attempts })).rejects.toThrow("last");
	});
});
