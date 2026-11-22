import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Text, visibleWidth } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { Component, Theme, TUI } from "@oh-my-pi/pi-tui";
import { createInlineTranslation, createTranslationReader } from "../src/harness/omp/panel.ts";

type ReaderUI = Parameters<typeof createTranslationReader>[0];
type ReaderFactory<T> = (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component | Promise<Component>;

function inline(source: string) {
	return createInlineTranslation({ Text }, source, (line) => line, () => true);
}

function contentRows(rows: readonly string[]) {
	return rows.map((row) => stripVTControlCharacters(row).trimEnd());
}

function expectSafeRows(rows: readonly string[], width: number) {
	for (const row of rows) {
		expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		expect(row).not.toMatch(/[\r\n\t]/);
	}
}

function harness() {
	let overlay: Component | undefined;
	let redraws = 0;
	const overlays: Parameters<ReaderUI["custom"]>[1][] = [];
	const terminal = { rows: 24 };
	const tui = { terminal, requestRender() { redraws++; } } as unknown as TUI;
	const keys = KeybindingsManager.inMemory();
	const ui: ReaderUI = {
		custom<T>(factory: ReaderFactory<T>, options?: Parameters<ReaderUI["custom"]>[1]) {
			overlays.push(options);
			const { promise, resolve, reject } = Promise.withResolvers<T>();
			const component = factory(tui, {} as never, keys, resolve);
			if (component instanceof Promise) throw new Error("Expected a synchronous reader factory");
			overlay = component;
			options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
			return promise;
		},
	};
	const reader = createTranslationReader(ui, { Text });
	return { reader, overlays, terminal, overlay: () => overlay!, redraws: () => redraws };
}

test("inline reserves source-dependent and width-dependent rows before translation", () => {
	const short = inline("A short thought.");
	const source = "Inspect the relevant implementation and preserve its existing behavior. ".repeat(16);
	const long = inline(source);
	expect(short.render(80)).toHaveLength(1);
	expect(long.render(80).length).toBeGreaterThan(3);
	expect(long.render(80).length).toBeGreaterThan(short.render(80).length);
	expect(long.render(20).length).toBeGreaterThan(long.render(80).length);
	expect(inline("one\ntwo\nthree\nfour\nfive").render(80)).toHaveLength(5);
	expect(inline("").render(80)).toEqual([]);
	expect(long.render(0)).toEqual([]);
	expect(long.render(Number.NaN)).toEqual([]);
});

test("streaming renders more than three full Japanese rows without changing the reservation", () => {
	const component = inline("one\ntwo\nthree\nfour\nfive\nsix");
	const reserved = component.render(80).length;
	const fragments = ["一行目", "一行目\n二行目", "一行目\n二行目\n三行目\n四行目\n五行目"];
	for (const text of fragments) {
		component.setTranslation(text, false);
		const rows = component.render(80);
		expect(rows).toHaveLength(reserved);
		expect(contentRows(rows.slice(0, text.split("\n").length))).toEqual(text.split("\n"));
		expect(rows.join("")).not.toContain("/thinking-ja show");
	}
	component.setTranslation(fragments[2]!, true);
	expect(component.render(80)).toHaveLength(reserved);
	expect(component.render(80)[5]).toBe("");
});

test("overflow grows only once at final and preserves every final Japanese line", () => {
	const component = inline("Short source.");
	const reserved = component.render(20).length;
	const lines = Array.from({ length: 18 }, (_, i) => `日本語の訳${i}`);
	const heights = [reserved];
	for (let count = 1; count <= lines.length; count++) {
		component.setTranslation(lines.slice(0, count).join("\n"), false);
		const rows = component.render(20);
		expect(rows).toHaveLength(reserved);
		expect(contentRows(rows)[0]).toBe(lines[0]!);
		heights.push(rows.length);
	}
	component.setTranslation(lines.join("\n"), true);
	const complete = component.render(20);
	heights.push(complete.length);
	expect(contentRows(complete)).toEqual(lines);
	expect(heights.filter((height, index) => index > 0 && height > heights[index - 1]!).length).toBe(1);
	component.invalidate?.();
	expect(contentRows(component.render(20))).toEqual(lines);
});

test("source appends and replacements update the estimate without shrinking existing rows", () => {
	const component = inline("A");
	const first = component.render(40).length;
	const source = "A".repeat(200) + "\nNext line.";
	component.setSource(source);
	expect(component.render(40).length).toBeGreaterThan(first);
	expect(component.render(40)).toEqual(inline(source).render(40));
	const reserved = component.render(40).length;
	component.setSource("Replacement.");
	expect(component.render(40)).toHaveLength(reserved);
	component.setTranslation("短い訳", true);
	expect(component.render(40)).toHaveLength(reserved);
	expect(component.render(80)).toHaveLength(1);
});

test("inline sanitizes source and translation controls before applying trusted styling", () => {
	const source = "\x1b[31mVisible source.\x1b[0m\x1b]52;c;hidden\x07";
	const component = createInlineTranslation({ Text }, source, (line) => `\x1b[2m${line}\x1b[22m`, () => true);
	expect(component.render(80).length).toBe(inline("Visible source.").render(80).length);
	component.setTranslation("\x1b[2J安全\x1b]52;c;clipboard\x07\x1b_Gimage\x1b\\\x9dhidden\x07\x00\x08\r\n次\t行\u202e", true);
	const rows = component.render(80);
	expect(rows[0]).toStartWith("\x1b[2m");
	const plain = contentRows(rows);
	expect(plain).toEqual(["安全", "次    行"]);
	expect(plain.join("")).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]|clipboard|image|hidden/);
	expectSafeRows(rows, 80);
	component.setTranslation("安全\x1b]52;c;unfinished", true);
	expect(contentRows(component.render(80)).join("")).toBe("安全");
});

test("CJK and graphemes remain width-safe through resize and full final text survives", () => {
	const source = "Inspect the Unicode layout and every translated character. ".repeat(10);
	const component = inline(source);
	const text = "日本語の翻訳を最後まで保持する。👨‍👩‍👧‍👦e\u0301".repeat(8);
	component.setTranslation(text, true);
	for (const width of [80, 12, 3, 2, 1, 0, 37, 80]) {
		const rows = component.render(width);
		expectSafeRows(rows, width);
		if (width >= 2) expect(contentRows(rows).join("")).toBe(text);
		else expect(rows.join("")).toBe("");
	}
	const unicodeSource = inline("日本語👨‍👩‍👧‍👦\n次の行".repeat(8));
	expect(unicodeSource.render(12).length).toBeGreaterThan(unicodeSource.render(80).length);
});

test("disabled inline components return no rows and retain complete translation for re-enable", () => {
	let enabled = false;
	const component = createInlineTranslation({ Text }, "one\ntwo\nthree\nfour", (line) => line, () => enabled);
	component.setTranslation("一\n二\n三\n四", true);
	expect(component.render(80)).toEqual([]);
	enabled = true;
	expect(contentRows(component.render(80))).toEqual(["一", "二", "三", "四"]);
	enabled = false;
	expect(component.render(80)).toEqual([]);
});

test("reader opens only explicitly, uses full width, and retains a scrollable stable snapshot", async () => {
	const h = harness();
	expect(h.overlays).toEqual([]);
	const previous = Array.from({ length: 45 }, (_, i) => `過去の訳${i.toString().padStart(3, "0")}`).join("\n");
	const blocks = [previous, Array.from({ length: 100 }, (_, i) => `訳行${i.toString().padStart(3, "0")}`).join("\n")];
	const shown = h.reader.show(blocks);
	const overlay = h.overlay();
	expect(h.overlays).toHaveLength(1);
	expect(h.overlays[0]?.overlay).toBe(true);
	expect(h.overlays[0]?.overlayOptions).toMatchObject({ width: "100%" });
	expect(overlay.render(60).join("\n")).toContain("訳行000");
	expect(overlay.render(60).length).toBeLessThanOrEqual(Math.floor(h.terminal.rows * 0.8));
	expect(h.redraws()).toBe(0);
	blocks[1] = "後からの変更";
	expect(h.reader.show(["別のスナップショット"])).toBe(shown);
	expect(h.overlays).toHaveLength(1);
	overlay.handleInput?.("\x1b[F");
	expect(overlay.render(60).join("\n")).toContain("訳行099");
	overlay.handleInput?.("\x1b[H");
	expect(overlay.render(60).join("\n")).toContain("過去の訳000");
	overlay.handleInput?.("\x1b[6~");
	expect(overlay.render(60).join("\n")).not.toContain("過去の訳000");
	overlay.handleInput?.("\x1b[5~");
	expect(overlay.render(60).join("\n")).toContain("過去の訳000");
	for (const width of [2, 1, 0, 9, 60]) {
		h.terminal.rows = 6;
		const rows = overlay.render(width);
		expect(rows.length).toBeLessThanOrEqual(4);
		expectSafeRows(rows, width);
	}
	expect(overlay.render(60).join("\n")).not.toMatch(/後からの変更|別のスナップショット/);
	expect(h.redraws()).toBeGreaterThan(0);
	overlay.handleInput?.("\x1b");
	await shown;
});

test("reader disposal aborts the open overlay and prevents reopening", async () => {
	const h = harness();
	const shown = h.reader.show([]);
	expect(h.overlay().render(60).join("\n")).toContain("翻訳はまだありません。");
	h.reader.dispose();
	h.reader.dispose();
	await shown;
	expect(h.overlays[0]?.signal?.aborted).toBe(true);
	await h.reader.show(["破棄後"]);
	expect(h.overlays).toHaveLength(1);
});
