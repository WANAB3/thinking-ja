import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Text, type Component } from "@oh-my-pi/pi-tui";
import thinkingJa from "../src/harness/omp/index.ts";

const ENDPOINT = "http://127.0.0.1:18095/v1/completions";
const PREFIX = "The original English reasoning is still growing";
const COMPLETE = `${PREFIX} and its final paragraph must also be translated.`;

/**
 * The local translator endpoint, stubbed at `fetch`: answers `ローカル訳:<prompt>`,
 * or HTTP 503 while `translatorDown`. No socket, so the harness clock alone
 * drives every test.
 */
let translatorDown = false;
/** Texts the local translator endpoint was asked to translate. */
let localRequests: string[] = [];
let destinations: string[] = [];
const gates = new Map<string, Promise<void>>();
const streams = new Map<string, ReadableStream<Uint8Array>>();
const originalConfig = process.env.THINKING_JA_CONFIG;
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
	async (url: string | URL | Request, init?: RequestInit) => {
		destinations.push(String(url));
		const body = JSON.parse(String(init?.body)) as { prompt: string };
		localRequests.push(body.prompt);
		if (translatorDown) return new Response("down", { status: 503 });
		await gates.get(body.prompt);
		const stream = streams.get(body.prompt);
		if (stream) return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		return Response.json({ choices: [{ text: `ローカル訳:${body.prompt}` }] });
	},
	{ preconnect: realFetch.preconnect },
);
const configDir = mkdtempSync(join(tmpdir(), "thinking-ja-omp-"));
const configFile = join(configDir, "config.json");
writeFileSync(configFile, JSON.stringify({ translators: [{ url: ENDPOINT, prompt: "{{text}}" }] }));
writeFileSync(join(configDir, "invalid.json"), "{");
writeFileSync(join(configDir, "empty.json"), JSON.stringify({ translators: [] }));
afterAll(() => {
	globalThis.fetch = realFetch;
	if (originalConfig === undefined) delete process.env.THINKING_JA_CONFIG;
	else process.env.THINKING_JA_CONFIG = originalConfig;
	rmSync(configDir, { recursive: true, force: true });
});
beforeEach(() => {
	translatorDown = false;
	localRequests = [];
	destinations = [];
	gates.clear();
	streams.clear();
	process.env.THINKING_JA_CONFIG = configFile;
});

type CacheEntry = { type: "custom"; customType: string; data: { hash: string; ja: string; v: number; order?: number } };
type Part = { type: "thinking"; thinking: string } | { type: "toolCall"; id: string };

function harness(branch: CacheEntry[] = []) {
	const events = new Map<string, (event: unknown, context: unknown) => unknown>();
	const timers = new Map<number, { at: number; run: () => void }>();
	const modelCalls: string[] = [];
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
		models: { resolve(role: string) { modelCalls.push(role); return { id: "claude-sonnet-5" }; } },
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
			createAgentSession() {
				modelCalls.push("createAgentSession");
				throw new Error("Thinking translation must never open a model session");
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
		appendEntry(customType: string, data: CacheEntry["data"]) { branch.push({ type: "custom", customType, data }); },
		logger: {
			debug() { },
			warn() { },
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
		modelCalls,
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

test("a delayed configured translation fills the original block's preallocated rows", async () => {
	const delayed = Promise.withResolvers<void>();
	gates.set(COMPLETE, delayed.promise);
	const h = harness();
	await h.emit("session_start");
	expect(h.rows()).toEqual([]);
	await h.emit("message_start");
	const view = h.think(PREFIX)!;
	const blank = h.rows();
	expect(blank.length).toBeGreaterThan(0);
	expect(blank.join("")).toBe("");
	await h.advance(2000);
	expect(localRequests).toEqual([]);
	expect(h.rows()).toEqual(blank);
	expect(h.think(COMPLETE)).toBe(view);
	const reserved = h.rows().length;
	await h.emit("message_end");
	await h.advance(0);
	expect(h.rows().join("")).toBe("");
	delayed.resolve();
	await h.advance(0);
	expect(localRequests).toEqual([COMPLETE]);
	expect(h.rows()).toHaveLength(reserved);
	expect(h.rows()[0]).toBe(`ローカル訳:${COMPLETE}`);
	expect(h.render(COMPLETE)).toBe(view);
	expect(h.branch[0]?.data.ja).toBe(`ローカル訳:${COMPLETE}`);
});

test("a frame mounted before its final event receives the finished translation", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.emit("message_start");
	h.think(PREFIX);
	const mounted = h.render(COMPLETE)!;
	h.update(COMPLETE, 0, true);
	await h.advance(500);
	expect(mounted.render(160).join("").trim()).toBe(`ローカル訳:${COMPLETE}`);
	expect(localRequests).toEqual([COMPLETE]);
});

test("resume and toggling display cached translations even after the translator config is removed", async () => {
	const first = harness();
	await first.emit("session_start");
	first.render(COMPLETE);
	await first.advance(500);
	const h = harness(first.branch);
	process.env.THINKING_JA_CONFIG = join(configDir, "absent.json");
	await h.emit("session_start");
	h.render(COMPLETE);
	expect(h.rows()[0]).toBe(`ローカル訳:${COMPLETE}`);
	await h.toggle();
	expect(h.rows()).toEqual([]);
	await h.emit("message_start");
	h.think(COMPLETE);
	await h.emit("message_end");
	await h.advance(2000);
	expect(h.rows()).toEqual([]);
	await h.toggle();
	expect(h.rows()[0]).toBe(`ローカル訳:${COMPLETE}`);
	expect(await h.readAll()).toContain(`ローカル訳:${COMPLETE}`);
	expect(localRequests).toEqual([COMPLETE]);
	expect(h.modelCalls).toEqual([]);
});

test("only the last visible frame is bought when it follows message_end", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.emit("message_start");
	h.think(PREFIX);
	await h.toggle();
	await h.toggle();
	await h.advance(2000);
	expect(localRequests).toEqual([]);
	h.update(COMPLETE);
	await h.emit("message_end");
	h.render(COMPLETE);
	await h.advance(500);
	expect(localRequests).toEqual([COMPLETE]);
	expect(h.rows()[0]).toBe(`ローカル訳:${COMPLETE}`);
});

test("an offline translator skips the block without calling a model, and the next reply can recover", async () => {
	translatorDown = true;
	const h = harness();
	await h.emit("session_start");
	await h.emit("message_start");
	h.think(COMPLETE);
	await h.emit("message_end");
	await h.advance(500);
	expect(h.rows().join("")).toBe("");
	expect(h.branch).toEqual([]);
	expect(destinations).toEqual([ENDPOINT]);
	expect(h.modelCalls).toEqual([]);
	translatorDown = false;
	await h.emit("message_start");
	h.think(COMPLETE);
	await h.emit("message_end");
	await h.advance(0);
	expect(h.rows()[0]).toBe(`ローカル訳:${COMPLETE}`);
	expect(destinations).toEqual([ENDPOINT, ENDPOINT]);
	expect(h.modelCalls).toEqual([]);
});

test.each(["absent.json", "invalid.json", "empty.json"])("%s never sends untranslated thinking to any model or endpoint", async (file) => {
	process.env.THINKING_JA_CONFIG = join(configDir, file);
	const h = harness();
	await h.emit("session_start");
	expect(h.render(COMPLETE)).toBeUndefined();
	await h.emit("message_start");
	h.think(PREFIX);
	h.update(COMPLETE, 0, true);
	expect(h.render(COMPLETE)).toBeUndefined();
	await h.emit("message_end");
	await h.advance(2000);
	expect(destinations).toEqual([]);
	expect(h.modelCalls).toEqual([]);
	expect(h.branch).toEqual([]);
});

test("a completed paragraph remains under the same original after later paragraphs arrive and on replay", async () => {
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
	expect(h.modelCalls).toEqual([]);
});

test("post-tool local index zero closes at global index two even before its first frame", async () => {
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
	const first = "Check the source before making changes.";
	const second = "Then inspect the tests.";
	let writer!: ReadableStreamDefaultController<Uint8Array>;
	streams.set(first, new ReadableStream({ start(c) { writer = c; } }));
	const push = (data: unknown) => writer.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
	const h = harness();
	await h.emit("session_start");
	await h.emit("message_start");
	const full = `${first} ${second}`;
	const view = h.think(`${first} Then inspect`)!;
	await h.advance(0);
	expect(localRequests).toEqual([first]);
	push({ choices: [{ index: 0, text: "まず原文を" }] });
	await h.advance(0);
	expect(view.render(80).join("").trim()).toBe("まず原文を");
	expect(h.branch).toEqual([]);
	const mounted = h.render(full)!;
	h.update(full, 0, true);
	expect(mounted.render(80).join("").trim()).toBe("まず原文を");
	await h.advance(0);
	expect(localRequests).toEqual([first, second]);
	expect(mounted.render(80).join("").trim()).toBe("まず原文を");
	push({ choices: [{ index: 0, text: "確認する。", finish_reason: "stop" }] });
	writer.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
	writer.close();
	await h.advance(0);
	const ja = `まず原文を確認する。ローカル訳:${second}`;
	expect(mounted.render(160).join("").trim()).toBe(ja);
	expect(h.branch.map(entry => entry.data.ja)).toEqual([ja]);
});

test("a truncated local stream retracts its draft without discarding confirmed sentences or starting a model", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.emit("message_start");
	let send!: ReadableStreamDefaultController<Uint8Array>;
	streams.set(PREFIX, new ReadableStream({ start(c) { send = c; } }));
	const first = "The first sentence translated successfully.";
	const full = `${first}\n\n${PREFIX}`;
	const view = h.think(full)!;
	h.update(full, 0, true);
	await h.advance(0);
	send.enqueue(new TextEncoder().encode('data: {"choices":[{"text":"途切れた仮訳"}]}\n\n'));
	await h.advance(0);
	expect(view.render(160).map(line => line.trim()).filter(Boolean)).toEqual([`ローカル訳:${first}`, "途切れた仮訳"]);
	send.enqueue(new TextEncoder().encode('data: {"choices":[{"text":"","finish_reason":"length"}]}\n\n'));
	await h.advance(500);
	expect(localRequests).toEqual([first, PREFIX]);
	expect(destinations).toEqual([ENDPOINT, ENDPOINT]);
	expect(h.modelCalls).toEqual([]);
	expect(h.branch).toEqual([]);
	expect(view.render(160).map(line => line.trim()).filter(Boolean)).toEqual([`ローカル訳:${first}`]);
});
