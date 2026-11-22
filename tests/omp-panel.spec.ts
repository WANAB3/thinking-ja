import { expect, test } from "bun:test";
import { Text, visibleWidth } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { Component, Theme, TUI } from "@oh-my-pi/pi-tui";
import { createTranslationPanel } from "../src/harness/omp/panel.ts";

type PanelUI = Parameters<typeof createTranslationPanel>[0];
type ReaderFactory<T> = (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component | Promise<Component>;

function harness() {
	let widget: Component | undefined;
	let overlay: Component | undefined;
	let redraws = 0;
	const widgets: { mounted: boolean; placement?: string }[] = [];
	const overlays: Parameters<PanelUI["custom"]>[1][] = [];
	const terminal = { rows: 24 };
	const tui = { terminal, requestRender() { redraws++; } } as unknown as TUI;
	const keys = KeybindingsManager.inMemory();
	const ui: PanelUI = {
		setWidget(_key, content, options) {
			widgets.push({ mounted: content !== undefined, placement: options?.placement });
			widget = typeof content === "function" ? content(tui, {} as never) : undefined;
		},
		custom<T>(factory: ReaderFactory<T>, options?: Parameters<PanelUI["custom"]>[1]) {
			overlays.push(options);
			const { promise, resolve, reject } = Promise.withResolvers<T>();
			const component = factory(tui, {} as never, keys, resolve);
			if (component instanceof Promise) throw new Error("Expected a synchronous reader factory");
			overlay = component;
			options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
			return promise;
		},
	};
	const panel = createTranslationPanel(ui, { Text });
	return {
		panel, widgets, overlays, terminal,
		widget: () => widget!,
		overlay: () => overlay!,
		redraws: () => redraws,
	};
}

test("caption mounts on enable only and keeps exactly three width-safe physical rows", () => {
	const h = harness();
	expect(h.widgets).toEqual([]);
	h.panel.setEnabled(true);
	const widget = h.widget();
	expect(h.widgets).toEqual([{ mounted: true, placement: "aboveEditor" }]);
	for (const text of ["", "確定した単位の日本語訳。", "一行目\n二行目\n三行目\n四行目", "long_code_".repeat(80), "👨‍👩‍👧‍👦を確認する。", ""]) {
		h.panel.setCaption(text);
		for (const width of [80, 12, 3, 2, 1, 0, 37]) {
			const rows = widget.render(width);
			expect(rows).toHaveLength(3);
			for (const row of rows) {
				expect(visibleWidth(row)).toBeLessThanOrEqual(width);
				expect(row).not.toMatch(/[\r\n\t]/);
			}
		}
		expect(h.widget()).toBe(widget);
	}
	expect(widget.render(80)).toEqual(["", "", ""]);
	expect(h.redraws()).toBeGreaterThan(0);
	expect(h.widgets).toHaveLength(1);
	expect(h.overlays).toHaveLength(0);
});

test("caption indicates overflow and strips terminal commands and controls", () => {
	const h = harness();
	h.panel.setEnabled(true);
	h.panel.setCaption("\x1b[2J安全\x1b]52;c;clipboard\x07\x1b_Gimage\x1b\\\x9dhidden\x07\x00\x08\r\n次\t行");
	const rows = h.widget().render(80);
	expect(rows.join("\n")).toContain("安全");
	expect(rows.join("\n")).toContain("次    行");
	expect(rows.join("")).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
	expect(rows.join("")).not.toMatch(/clipboard|image|hidden/);
	h.panel.setCaption("一\n二\n三\n四");
	expect(h.widget().render(80)[2]).toContain("/thinking-ja show");
});

test("explicit disable reclaims rows and repeated enable or disable is idempotent", () => {
	const h = harness();
	h.panel.setEnabled(false);
	h.panel.setEnabled(true);
	h.panel.setEnabled(true);
	h.panel.setEnabled(false);
	h.panel.setEnabled(false);
	h.panel.setCaption("無効中の更新");
	expect(h.widgets.map((entry) => entry.mounted)).toEqual([true, false]);
	h.panel.setEnabled(true);
	expect(h.widgets.map((entry) => entry.mounted)).toEqual([true, false, true]);
	h.panel.dispose();
	h.panel.dispose();
	h.panel.setEnabled(true);
	h.panel.setCaption("破棄後");
	expect(h.widgets.map((entry) => entry.mounted)).toEqual([true, false, true, false]);
});

test("reader is a bounded stable snapshot with reachable beginning and end", async () => {
	const h = harness();
	const previous = Array.from({ length: 45 }, (_, i) => `過去の訳${i.toString().padStart(3, "0")}`).join("\n");
	const blocks = [previous, Array.from({ length: 100 }, (_, i) => `訳行${i.toString().padStart(3, "0")}`).join("\n")];
	const shown = h.panel.show(blocks);
	const overlay = h.overlay();
	expect(h.overlays).toHaveLength(1);
	expect(h.overlays[0]?.overlay).toBe(true);
	expect(h.widgets).toHaveLength(0);
	expect(overlay.render(60).join("\n")).toContain("訳行000");
	expect(overlay.render(60).length).toBeLessThanOrEqual(Math.floor(h.terminal.rows * 0.8));
	blocks[1] = "後からの変更";
	h.panel.setCaption("新着訳");
	expect(h.panel.show(["別のスナップショット"])).toBe(shown);
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
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
	}
	expect(overlay.render(60).join("\n")).not.toMatch(/後からの変更|新着訳|別のスナップショット/);
	overlay.handleInput?.("\x1b");
	await shown;
});

test("reader disposal aborts the open overlay without opening anything automatically", async () => {
	const h = harness();
	const shown = h.panel.show([]);
	expect(h.overlay().render(60).join("\n")).toContain("翻訳はまだありません。");
	h.panel.dispose();
	await shown;
	expect(h.overlays[0]?.signal?.aborted).toBe(true);
	await h.panel.show(["破棄後"]);
	expect(h.overlays).toHaveLength(1);
});
