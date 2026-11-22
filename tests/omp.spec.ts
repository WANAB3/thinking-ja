import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Text, type Component } from "@oh-my-pi/pi-tui";
import thinkingJa from "../src/harness/omp/index.ts";

const TRANSLATION = "原文を保ったまま、確定した思考の日本語訳を表示する。";
const PREFIX = "The original English reasoning is still growing.";
const COMPLETE = `${PREFIX} Its final paragraph must also be translated.`;

/**
 * The local translator endpoint, stubbed at `fetch`: answers `ローカル訳:<prompt>`,
 * or HTTP 503 while `translatorDown`. No socket, so the harness clock alone
 * drives every test.
 */
let translatorDown = false;
/** Texts the local translator endpoint was asked to translate. */
let localRequests: string[] = [];
const gates = new Map<string, Promise<void>>();
const streams = new Map<string, ReadableStream<Uint8Array>>();
const originalConfig = process.env.THINKING_JA_CONFIG;
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
	async (_url: string | URL | Request, init?: RequestInit) => {
		if (translatorDown) return new Response("down", { status: 503 });
		const body = JSON.parse(String(init?.body)) as { prompt: string };
		localRequests.push(body.prompt);
		await gates.get(body.prompt);
		const stream = streams.get(body.prompt);
		if (stream) return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		return Response.json({ choices: [{ text: `ローカル訳:${body.prompt}` }] });
	},
	{ preconnect: realFetch.preconnect },
);
const configDir = mkdtempSync(join(tmpdir(), "thinking-ja-omp-"));
const configFile = join(configDir, "config.json");
writeFileSync(configFile, JSON.stringify({ translators: [{ url: "http://translator.test/v1/completions", prompt: "{{text}}" }] }));
afterAll(() => {
	globalThis.fetch = realFetch;
	if (originalConfig === undefined) delete process.env.THINKING_JA_CONFIG;
	else process.env.THINKING_JA_CONFIG = originalConfig;
	rmSync(configDir, { recursive: true, force: true });
});
beforeEach(() => {
	translatorDown = false;
	localRequests = [];
	gates.clear();
	streams.clear();
	process.env.THINKING_JA_CONFIG = join(configDir, "absent.json");
});

type CacheEntry = { customType: string; data: { hash: string; ja: string; v: number; order?: number } };
type Part = { type: "thinking"; thinking: string } | { type: "toolCall"; id: string };

function harness(branch: CacheEntry[] = []) {
	const events = new Map<string, (event: unknown, context: unknown) => unknown>();
	const timers = new Map<number, { at: number; run: () => void }>();
	/** Notes the LLM role path was asked to translate. */
	const requests: string[] = [];
	let now = 0;
	let nextTimer = 0;
	let renderer: (context: unknown, theme: unknown) => Component | undefined = () => undefined;
	let command: (args: string) => Promise<void> = async () => { };
	let inline: Component | undefined;
	let reader = "";
	let parts: Part[] = [];
	const uiHost = { terminal: { rows: 60 }, requestRender() { } };
	const context = {
		cwd: "/test",
		mode: "tui",
		models: { resolve: () => ({ id: "test" }) },
		modelRegistry: {},
		sessionManager: { getBranch: () => branch },
		setTimeout(run: () => void, delay: number) {
			const id = ++nextTimer;
			timers.set(id, { at: now + delay, run });
			return id;
		},
		clearTimer(id: number) {
			timers.delete(id);
		},
		ui: {
			notify() { },
			rerenderMessage() { },
			async custom(factory: (tui: typeof uiHost) => Component) {
				reader = factory(uiHost).render(160).map(line => line.trimEnd()).join("\n");
			},
		},
	};
	const pi = {
		pi: {
			Text,
			SessionManager: { inMemory: () => ({}) },
			AgentRegistry: class { },
			async createAgentSession() {
				let listener: ((event: unknown) => void) | undefined;
				return {
					session: {
						subscribe(callback: typeof listener) {
							listener = callback;
							return () => {
								listener = undefined;
							};
						},
						async prompt(prompt: string) {
							requests.push(prompt.split("<notes>\n")[1]!.split("\n</notes>")[0]!);
							listener?.({ type: "turn_end", message: { content: [{ type: "text", text: TRANSLATION }] } });
						},
						async dispose() { },
					},
				};
			},
		},
		on(name: string, handler: (event: unknown, context: unknown) => unknown) {
			events.set(name, handler);
		},
		registerAssistantThinkingRenderer(callback: typeof renderer) {
			renderer = callback;
		},
		registerCommand(_name: string, registration: { handler: (args: string, context: unknown) => Promise<void> }) {
			command = (args) => registration.handler(args, context);
		},
		appendEntry(customType: string, data: CacheEntry["data"]) { branch.push({ customType, data }); },
		logger: {
			debug() { },
			warn(message: string) {
				throw new Error(message);
			},
		},
	};
	thinkingJa(pi as unknown as ExtensionAPI);
	const render = (text: string, local = 0) => inline = renderer(
		{ text, contentIndex: local, thinkingIndex: 0, requestRender: uiHost.requestRender },
		{ fg: (_color: string, line: string) => line },
	);
	function update(text: string, index = 0, end = false) {
		parts[index] = { type: "thinking", thinking: text };
		const partial = { role: "assistant", content: parts };
		events.get("message_update")?.({
			message: partial, assistantMessageEvent: { type: end ? "thinking_end" : "thinking_delta", contentIndex: index, content: text, partial },
		}, context);
	}
	return {
		requests,
		branch, render, update,
		async emit(name: string) {
			if (name === "message_start") parts = [];
			await events.get(name)?.({ message: { role: "assistant", content: parts } }, context);
		},
		tool() { parts.push({ type: "toolCall", id: `tool-${parts.length}` }); },
		think(text: string) { update(text); return render(text); },
		rows(width = 160) { return inline?.render(width).map(line => line.trimEnd()) ?? []; },
		toggle() { return command(""); },
		async readAll() { await command("show"); return reader; },
		/** Settles pending async work, then runs due timers in order, settling after each. */
		async advance(ms: number) {
			const until = now + ms;
			for (; ;) {
				for (let i = 0; i < 20; i++) await setImmediate();
				const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				now = due[1].at;
				timers.delete(due[0]);
				due[1].run();
			}
			now = until;
		},
	};
}

test("a delayed role translation fills the original block's preallocated rows", async () => {
	const h = harness();
	await h.emit("session_start");
	expect(h.rows()).toEqual([]);
	await h.emit("message_start");
	const view = h.think(PREFIX)!;
	const blank = h.rows();
	expect(blank.length).toBeGreaterThan(0);
	expect(blank.join("")).toBe("");
	await h.advance(2000);
	expect(h.requests).toEqual([]);
	expect(h.rows()).toEqual(blank);
	expect(h.think(COMPLETE)).toBe(view);
	const reserved = h.rows().length;
	await h.emit("message_end");
	await h.advance(500);
	expect(h.requests).toEqual([COMPLETE]);
	expect(h.rows()).toHaveLength(reserved);
	expect(h.rows()[0]).toBe(TRANSLATION);
	expect(h.render(COMPLETE)).toBe(view);
	expect(h.branch[0]?.data.ja).toBe(TRANSLATION);
});

test("resume and toggling reuse complete translations without paying again", async () => {
	const first = harness();
	await first.emit("session_start");
	first.render(COMPLETE);
	await first.advance(500);
	const h = harness(first.branch);
	await h.emit("session_start");
	h.render(COMPLETE);
	expect(h.rows()[0]).toBe(TRANSLATION);
	await h.toggle();
	expect(h.rows()).toEqual([]);
	await h.emit("message_start");
	h.think(COMPLETE);
	await h.emit("message_end");
	await h.advance(2000);
	expect(h.rows()).toEqual([]);
	await h.toggle();
	expect(h.rows()[0]).toBe(TRANSLATION);
	expect(await h.readAll()).toContain(TRANSLATION);
	expect(h.requests).toEqual([]);
});

test("only the last visible frame is bought when it follows message_end", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.emit("message_start");
	h.think(PREFIX);
	await h.toggle();
	await h.toggle();
	await h.advance(2000);
	expect(h.requests).toEqual([]);
	h.update(COMPLETE);
	await h.emit("message_end");
	h.render(COMPLETE);
	await h.advance(500);
	expect(h.requests).toEqual([COMPLETE]);
	expect(h.rows()[0]).toBe(TRANSLATION);
});

test("failed local service falls back after the visible block ends", async () => {
	process.env.THINKING_JA_CONFIG = configFile;
	translatorDown = true;
	const h = harness();
	await h.emit("session_start");
	await h.emit("message_start");
	h.think(COMPLETE);
	await h.emit("message_end");
	await h.advance(500);
	expect(h.requests).toEqual([COMPLETE]);
	expect(h.rows()[0]).toBe(TRANSLATION);
});

test("a completed paragraph remains under the same original after later paragraphs arrive and on replay", async () => {
	process.env.THINKING_JA_CONFIG = configFile;
	const h = harness();
	await h.emit("session_start");
	await h.emit("message_start");
	const first = "The first paragraph is already closed.";
	const second = "A second paragraph is being written.";
	const full = `${first}\n\n${second}`;
	h.think(first);
	h.update(`${first}\n\n`);
	await h.advance(0);
	expect(h.rows().filter(Boolean)).toEqual([`ローカル訳:${first}`]);
	expect(localRequests).toEqual([first]);
	h.think(full);
	h.update(full, 0, true);
	await h.advance(0);
	expect(h.rows().filter(Boolean)).toEqual([`ローカル訳:${first}`, `ローカル訳:${second}`]);
	expect(await h.readAll()).toContain(`ローカル訳:${first}\n\nローカル訳:${second}`);
	expect(h.branch[0]?.data.ja).toBe(`ローカル訳:${first}\n\nローカル訳:${second}`);
	await h.emit("message_end");
	await h.emit("message_start");
	await h.emit("message_end");
	h.render(full);
	expect(h.rows().filter(Boolean)).toEqual([`ローカル訳:${first}`, `ローカル訳:${second}`]);
	await h.advance(1000);
	expect(localRequests).toEqual([first, second]);
	expect(h.requests).toEqual([]);
});

test("post-tool local index zero closes at global index two even before its first frame", async () => {
	process.env.THINKING_JA_CONFIG = configFile;
	const h = harness();
	await h.emit("session_start");
	await h.emit("message_start");
	const pre = "The same reasoning prefix before the tool.";
	const post = "The same reasoning prefix after the tool.";
	const delayed = Promise.withResolvers<void>();
	gates.set(pre, delayed.promise);
	const earlier = h.think(pre)!;
	h.update(pre, 0, true);
	h.tool();
	h.update(post, 2, true);
	const later = h.render(post, 0)!;
	await h.advance(0);
	expect(h.rows()[0]).toBe(`ローカル訳:${post}`);
	expect(earlier.render(160).join("").trim()).toBe("");
	delayed.resolve();
	await h.advance(0);
	expect(earlier.render(160).join("").trim()).toBe(`ローカル訳:${pre}`);
	expect(later.render(160).join("").trim()).toBe(`ローカル訳:${post}`);
	expect(h.rows()[0]).toBe(`ローカル訳:${post}`);
	const all = await h.readAll();
	expect(all.indexOf(pre)).toBeGreaterThanOrEqual(0);
	expect(all.indexOf(post)).toBeGreaterThan(all.indexOf(pre));
	expect(localRequests).toEqual([pre, post]);
});

test("folded or never-rendered provider text is not submitted to a translator", async () => {
	process.env.THINKING_JA_CONFIG = configFile;
	const h = harness();
	await h.emit("session_start");
	await h.emit("message_start");
	h.update("A complete block hidden by the UI.", 0, true);
	h.tool();
	const visible = "This is the visible thinking...";
	h.render(visible, 0);
	h.update("This is the visible thinking.\n```ts\nnot_visible();\n```", 2, true);
	await h.advance(500);
	expect(localRequests).toEqual([visible]);
	expect(h.rows()[0]).toBe(`ローカル訳:${visible}`);
});

test("the first Japanese delta is visible before either stream ends; later sentences cannot overtake it", async () => {
	process.env.THINKING_JA_CONFIG = configFile;
	const first = "Check the source before making changes.";
	const second = "Then inspect the tests.";
	let writer!: ReadableStreamDefaultController<Uint8Array>;
	streams.set(first, new ReadableStream({ start(c) { writer = c; } }));
	const push = (data: unknown) => writer.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
	const h = harness();
	await h.emit("session_start");
	await h.emit("message_start");
	const full = `${first} ${second}`;
	const view = h.think(full)!;
	await h.advance(0);
	expect(localRequests).toEqual([first]);
	push({ choices: [{ index: 0, text: "まず原文を" }] });
	await h.advance(0);
	expect(view.render(80).join("").trim()).toBe("まず原文を");
	expect(h.branch).toEqual([]);
	h.update(full, 0, true);
	await h.advance(0);
	expect(localRequests).toEqual([first, second]);
	expect(view.render(80).join("").trim()).toBe("まず原文を");
	push({ choices: [{ index: 0, text: "確認する。", finish_reason: "stop" }] });
	writer.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
	writer.close();
	await h.advance(0);
	const ja = `まず原文を確認する。ローカル訳:${second}`;
	expect(view.render(160).join("").trim()).toBe(ja);
	expect(h.branch.map(entry => entry.data.ja)).toEqual([ja]);
});

test("a truncated live unit is not stored or bought again while the role supplies its full replacement", async () => {
	process.env.THINKING_JA_CONFIG = configFile;
	const h = harness();
	await h.emit("session_start");
	await h.emit("message_start");
	let send!: ReadableStreamDefaultController<Uint8Array>;
	streams.set(PREFIX, new ReadableStream({ start(c) { send = c; } }));
	const view = h.think(PREFIX)!;
	h.update(PREFIX, 0, true);
	await h.advance(0);
	send.enqueue(new TextEncoder().encode('data: {"choices":[{"text":"途切れた仮訳"}]}\n\n'));
	await h.advance(0);
	expect(view.render(80).join("").trim()).toBe("途切れた仮訳");
	send.enqueue(new TextEncoder().encode('data: {"choices":[{"text":"","finish_reason":"length"}]}\n\n'));
	await h.advance(500);
	expect(localRequests).toEqual([PREFIX]);
	expect(h.requests).toEqual([PREFIX]);
	expect(h.branch.map(entry => entry.data.ja)).toEqual([TRANSLATION]);
	expect(view.render(80).join("").trim()).toBe(TRANSLATION);
});
