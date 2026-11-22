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
const originalConfig = process.env.THINKING_JA_CONFIG;
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
	async (_url: string | URL | Request, init?: RequestInit) => {
		if (translatorDown) return new Response("down", { status: 503 });
		const body = JSON.parse(String(init?.body)) as { prompt: string };
		localRequests.push(body.prompt);
		await gates.get(body.prompt);
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
	let widget: Component | undefined;
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
			setWidget(_key: string, factory?: (tui: typeof uiHost) => Component) {
				widget = factory?.(uiHost);
			},
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
	const render = (text: string, local = 0) => renderer({ text, contentIndex: local, thinkingIndex: 0 }, {});
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
		rows(width = 160) { return widget?.render(width).map(line => line.trimEnd()) ?? []; },
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

test("a delayed role translation changes neither transcript nor widget height", async () => {
	const h = harness();
	await h.emit("session_start");
	const blank = h.rows();
	expect(blank).toHaveLength(3);
	await h.emit("message_start");
	expect(h.think(PREFIX)).toBeUndefined();
	await h.advance(2000);
	expect(h.requests).toEqual([]);
	expect(h.rows()).toEqual(blank);
	expect(h.think(COMPLETE)).toBeUndefined();
	await h.emit("message_end");
	await h.advance(500);
	expect(h.requests).toEqual([COMPLETE]);
	expect(h.rows()).toEqual([TRANSLATION, "", ""]);
	expect(h.render(COMPLETE)).toBeUndefined();
	expect(h.branch[0]?.data.ja).toBe(TRANSLATION);
});

test("resume and toggling reuse complete translations without paying again", async () => {
	const first = harness();
	await first.emit("session_start");
	expect(first.render(COMPLETE)).toBeUndefined();
	await first.advance(500);
	const h = harness(first.branch);
	await h.emit("session_start");
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

test("completed paragraphs replace the subtitle, while the reader keeps both and replay is free", async () => {
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
	expect(h.rows()).toEqual([`ローカル訳:${first}`, "", ""]);
	expect(localRequests).toEqual([first]);
	h.think(full);
	h.update(full, 0, true);
	await h.advance(0);
	expect(h.rows()).toEqual([`ローカル訳:${second}`, "", ""]);
	expect(await h.readAll()).toContain(`ローカル訳:${first}\nローカル訳:${second}`);
	expect(h.branch[0]?.data.ja).toBe(`ローカル訳:${first}\nローカル訳:${second}`);
	await h.emit("message_end");
	await h.emit("message_start");
	await h.emit("message_end");
	expect(h.render(full)).toBeUndefined();
	await h.advance(1000);
	expect(localRequests).toEqual([first, second]);
	expect(h.requests).toEqual([]);
});

test("post-tool local index zero closes at global index two even before its first frame", async () => {
	process.env.THINKING_JA_CONFIG = configFile;
	const h = harness();
	await h.emit("session_start");
	await h.emit("message_start");
	const pre = `${PREFIX} This is before the tool.`;
	const post = `${PREFIX} This is after the tool.`;
	const delayed = Promise.withResolvers<void>();
	gates.set(pre, delayed.promise);
	h.think(pre);
	h.update(pre, 0, true);
	h.tool();
	h.update(post, 2, true);
	expect(h.render(post, 0)).toBeUndefined();
	await h.advance(0);
	expect(h.rows()[0]).toBe(`ローカル訳:${post}`);
	// Finishing older work must not steal the subtitle or reverse the reader.
	delayed.resolve();
	await h.advance(0);
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
