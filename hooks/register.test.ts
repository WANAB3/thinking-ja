import type { SessionAppendInput } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

const CONFIG = { translators: [{ url: "http://translator.test/v1/completions", prompt: "[{{text}}]" }] };
const THINKING = "I should read the config file first, then run the tests.";
const TRANSLATION = "まず設定ファイルを読み、それからテストを実行する。";

/** What Claude Code passes to a `ui.render` hook for one of this mod's placed rows. */
const placedRow = (id: string) =>
	({
		plugin: "thinking-ja",
		component: "Placed",
		requestId: "row-1",
		surface: "terminal",
		viewport: { columns: 100, rows: 30 },
		props: { id, plugin: "thinking-ja" },
	}) as const;

const thinkingRow = (thinking: string): SessionAppendInput => ({
	message: { type: "assistant", role: "assistant", content: [{ type: "thinking", thinking }] },
	door: "response",
	origin: { kind: "model", model: "claude-test" },
	uuid: "row-uuid-1",
});

test("a kept thinking block gets a row right away, filled once the translator answers", async ($, on) => {
	const clock = mock.clock(on);
	mock.env(on, { HOME: "/home/test" });
	on("fs.exists", () => ({ value: true }));
	on("fs.read", () => ({ value: JSON.stringify(CONFIG) }));
	on("settings.read", () => ({ value: { showThinkingSummaries: true } }));
	const placed: string[] = [];
	on("ui.place", (_$, e) => {
		placed.push(e.id);
		return { value: { isPlaced: true, requestId: "row-1" } };
	});
	const posted: string[] = [];
	on("http.fetch", (_$, e) => {
		posted.push(typeof e.init?.body === "string" ? e.init.body : "");
		return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ choices: [{ text: TRANSLATION }] }) } };
	});
	on("session.start", (_$, e) => ({ cwd: e.cwd }));

	await $.session.start({ cwd: "/home/test/project", surface: "terminal", isInteractive: true });
	await $.session.append(thinkingRow(THINKING));
	expect(placed).toHaveLength(1);
	const id = placed[0] ?? "";

	// Placed before the translation: the row stays empty until the answer lands.
	const pending = await $.ui.mount(placedRow(id));
	expect(await pending.find({ type: "Text", text: TRANSLATION })).toBeUndefined();
	await pending.unmount();

	await clock.settle();
	expect(JSON.parse(posted[0] ?? "{}").prompt).toBe(`[${THINKING}]`);
	const filled = await $.ui.mount(placedRow(id));
	expect(await filled.find({ type: "Text", text: TRANSLATION })).toBeDefined();
});

test("an empty thinking block (summaries off) places nothing and calls no translator", async ($, on) => {
	mock.clock(on);
	mock.env(on, { HOME: "/home/test" });
	on("fs.exists", () => ({ value: true }));
	on("fs.read", () => ({ value: JSON.stringify(CONFIG) }));
	on("settings.read", () => ({ value: { showThinkingSummaries: true } }));
	const placed: string[] = [];
	on("ui.place", (_$, e) => {
		placed.push(e.id);
		return { value: { isPlaced: true, requestId: "row-1" } };
	});
	on("session.start", (_$, e) => ({ cwd: e.cwd }));

	await $.session.start({ cwd: "/home/test/project", surface: "terminal", isInteractive: true });
	await $.session.append(thinkingRow(""));
	expect(placed).toEqual([]);
});
