import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import thinkingJa from "../src/harness/omp/index.ts";

type Component = { render(width: number): readonly string[] };
class Container implements Component {
	children: Component[] = [];
	addChild(child: Component) {
		this.children.push(child);
	}
	clear() {
		this.children = [];
	}
	render(width: number) {
		return this.children.flatMap((child) => [...child.render(width)]);
	}
}
class Text implements Component {
	constructor(private text: string) { }
	render() {
		return [this.text];
	}
}

const TRANSLATION = "原文を保ったまま、確定した思考の日本語訳を表示する。";
const PREFIX = "The original English reasoning is still growing.";
const COMPLETE = `${PREFIX} Its final paragraph must also be translated.`;

/**
 * The local translator endpoint, stubbed at `fetch`: answers `ローカル訳:<prompt>`,
 * or HTTP 503 while `translatorDown`. No socket, so the harness clock alone
 * drives every test.
 */
let translatorDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
	async (_url: string | URL | Request, init?: RequestInit) => {
		if (translatorDown) return new Response("down", { status: 503 });
		const body = JSON.parse(String(init?.body)) as { prompt: string };
		return Response.json({ choices: [{ text: `ローカル訳:${body.prompt}` }] });
	},
	{ preconnect: realFetch.preconnect },
);
const configDir = mkdtempSync(join(tmpdir(), "thinking-ja-omp-"));
const configFile = join(configDir, "config.json");
writeFileSync(configFile, JSON.stringify({ translators: [{ url: "http://translator.test/v1/completions", prompt: "{{text}}" }] }));
afterAll(() => {
	globalThis.fetch = realFetch;
	rmSync(configDir, { recursive: true, force: true });
});
beforeEach(() => {
	translatorDown = false;
	process.env.THINKING_JA_CONFIG = join(configDir, "absent.json");
});

function harness() {
	const events = new Map<string, (event: unknown, context: unknown) => unknown>();
	const timers = new Map<number, { at: number; run: () => void }>();
	/** Notes the LLM role path was asked to translate. */
	const requests: string[] = [];
	let now = 0;
	let nextTimer = 0;
	let renderer: (context: unknown, theme: unknown) => Component | undefined = () => undefined;
	let toggle: () => Promise<void> = async () => { };
	const context = {
		cwd: "/test",
		models: { resolve: () => ({ id: "test" }) },
		modelRegistry: {},
		sessionManager: { getBranch: () => [] },
		setTimeout(run: () => void, delay: number) {
			const id = ++nextTimer;
			timers.set(id, { at: now + delay, run });
			return id;
		},
		clearTimer(id: number) {
			timers.delete(id);
		},
		ui: { notify() { } },
	};
	const pi = {
		pi: {
			Container,
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
		registerCommand(_name: string, command: { handler: (args: string, context: unknown) => Promise<void> }) {
			toggle = () => command.handler("", context);
		},
		appendEntry() { },
		logger: {
			debug() { },
			warn(message: string) {
				throw new Error(message);
			},
		},
	};
	thinkingJa(pi as unknown as ExtensionAPI);
	return {
		requests,
		async emit(name: string) {
			await events.get(name)?.({ message: { role: "assistant" } }, context);
		},
		render(text: string) {
			return renderer(
				{ text, contentIndex: 0, thinkingIndex: 0, requestRender() { } },
				{ fg: (_color: string, line: string) => line },
			);
		},
		toggle() {
			return toggle();
		},
		/** Runs due timers in order, letting each one's async work settle. */
		async advance(ms: number) {
			const until = now + ms;
			for (; ;) {
				const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				now = due[1].at;
				timers.delete(due[0]);
				due[1].run();
				for (let i = 0; i < 20; i++) await setImmediate();
			}
			now = until;
		},
	};
}

test("streaming pauses never insert translations; the mounted view fills after completion", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.emit("message_start");
	const view = h.render(PREFIX)!;
	await h.advance(2000);
	expect(h.requests).toEqual([]);
	expect(view.render(80)).toEqual([]);
	h.render(COMPLETE);
	await h.advance(2000);
	expect(h.requests).toEqual([]);
	expect(view.render(80)).toEqual([]);
	await h.emit("message_end");
	await h.advance(500);
	expect(h.requests).toEqual([COMPLETE]);
	expect(view.render(80)).toEqual([TRANSLATION]);
});

test("a cached translation stays visible in history but cannot cover a new live block", async () => {
	const h = harness();
	await h.emit("session_start");
	const historical = h.render(COMPLETE)!;
	await h.advance(500);
	expect(historical.render(80)).toEqual([TRANSLATION]);
	await h.emit("message_start");
	const live = h.render(COMPLETE)!;
	await h.advance(2000);
	expect(live.render(80)).toEqual([]);
	expect(historical.render(80)).toEqual([TRANSLATION]);
	await h.emit("message_end");
	await h.advance(500);
	expect(live.render(80)).toEqual([TRANSLATION]);
	expect(h.requests).toEqual([COMPLETE]);
	await h.toggle();
	expect(historical.render(80)).toEqual([]);
	expect(live.render(80)).toEqual([]);
	await h.toggle();
	expect(historical.render(80)).toEqual([TRANSLATION]);
	expect(live.render(80)).toEqual([TRANSLATION]);
	expect(h.requests).toEqual([COMPLETE]);
});

test("the final renderer flush supersedes the last streamed prefix before translation starts", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.emit("message_start");
	const pending = h.render(PREFIX)!;
	await h.toggle();
	await h.toggle();
	await h.advance(2000);
	expect(pending.render(80)).toEqual([]);
	expect(h.requests).toEqual([]);
	await h.emit("message_end");
	const final = h.render(COMPLETE)!;
	await h.advance(500);
	expect(h.requests).toEqual([COMPLETE]);
	expect(final.render(80)).toEqual([TRANSLATION]);
});

test("a configured local translator answers first; the LLM role is never asked", async () => {
	process.env.THINKING_JA_CONFIG = configFile;
	const h = harness();
	await h.emit("session_start");
	await h.emit("message_start");
	const view = h.render(COMPLETE)!;
	await h.emit("message_end");
	await h.advance(500);
	expect(view.render(80)).toEqual([`ローカル訳:${COMPLETE}`]);
	expect(h.requests).toEqual([]);
});

test("a local translator that is down falls back to the LLM role", async () => {
	process.env.THINKING_JA_CONFIG = configFile;
	translatorDown = true;
	const h = harness();
	await h.emit("session_start");
	await h.emit("message_start");
	const view = h.render(COMPLETE)!;
	await h.emit("message_end");
	await h.advance(500);
	expect(h.requests).toEqual([COMPLETE]);
	expect(view.render(80)).toEqual([TRANSLATION]);
});
