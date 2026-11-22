import { stripVTControlCharacters } from "node:util";
import type { ExtensionUIContext, Text } from "@oh-my-pi/pi-coding-agent";
import type { Component } from "@oh-my-pi/pi-tui";

/** Text is re-exported by pi-coding-agent and therefore available in pi.pi. */
type PanelHost = { Text: typeof Text };
type PanelUI = Pick<ExtensionUIContext, "setWidget" | "custom">;

const WIDGET_KEY = "thinking-ja-caption";
const CAPTION_ROWS = 3;
const EMPTY_ROWS = ["", "", ""];

/** Strip terminal commands before expanding whitespace; retain only printable text and newlines. */
function plainText(text: string): string {
	return stripVTControlCharacters(text
		.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
		.replace(/(?:\x1b[P_X^]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, ""))
		.replace(/\r\n?|[\u2028\u2029]/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

function columns(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

/**
 * Three physical caption rows, mounted only by an explicit enable. Updates never
 * replace the widget, editor, or transcript. Disable/dispose reclaim its rows.
 * The reader freezes its input at invocation and uses the host's text wrapping.
 * Default reader keys: arrows, PageUp/PageDown, Home/End, Escape; host remaps apply.
 */
export function createTranslationPanel(ui: PanelUI, host: PanelHost): {
	setEnabled(value: boolean): void;
	setCaption(text: string): void;
	show(blocks: readonly string[]): Promise<void>;
	dispose(): void;
} {
	let enabled = false;
	let disposed = false;
	let caption = "";
	let requestRender: (() => void) | undefined;
	let reader: { promise: Promise<void>; abort: AbortController } | undefined;
	const preview = new host.Text("", 0, 0);
	const overflow = new host.Text("… /thinking-ja show", 0, 0);
	const widget: Component = {
		render(width) {
			const available = columns(width);
			if (!caption || available === 0) return EMPTY_ROWS;
			// A two-cell grapheme cannot fit in a one-cell terminal. Do not let the
			// host wrapper's oversized grapheme create a fourth physical row.
			if (available === 1) return [".", "", ""];
			const wrapped = preview.render(available);
			const rows = Array.from({ length: CAPTION_ROWS }, (_, index) => wrapped[index] ?? "");
			if (wrapped.length > CAPTION_ROWS) rows[2] = overflow.render(available)[0] ?? "…";
			return rows;
		},
		invalidate() {
			preview.invalidate();
			overflow.invalidate();
		},
	};

	return {
		setEnabled(value) {
			if (disposed || enabled === value) return;
			enabled = value;
			if (enabled) {
				ui.setWidget(WIDGET_KEY, (tui) => {
					requestRender = () => tui.requestRender();
					return widget;
				}, { placement: "aboveEditor" });
			} else {
				ui.setWidget(WIDGET_KEY, undefined);
				requestRender = undefined;
			}
		},
		setCaption(text) {
			if (disposed) return;
			const next = plainText(text);
			if (caption === next) return;
			caption = next;
			preview.setText(caption);
			requestRender?.();
		},
		show(blocks) {
			if (disposed) return Promise.resolve();
			if (reader) return reader.promise;
			const pages = blocks.map(plainText);
			const snapshot = pages.join("\n\n") || "翻訳はまだありません。";
			const abort = new AbortController();
			const promise = ui.custom<void>((tui, _theme, keybindings, done) => {
				const body = new host.Text(snapshot, 0, 0);
				// Open where the subtitle came from, not at the start of a long session.
				let newest = pages.length > 1 ? new host.Text(pages[pages.length - 1]!, 0, 0) : undefined;
				const title = new host.Text("日本語訳", 0, 0);
				const help = new host.Text("↑↓ 移動 · PgUp/PgDn · Home/End · Esc 閉じる", 0, 0);
				let offset = 0;
				let pageSize = 1;
				let total = 0;
				const clamp = () => { offset = Math.max(0, Math.min(offset, Math.max(0, total - pageSize))); };
				return {
					render(width) {
						const available = columns(width);
						const height = Math.max(1, Math.min(30, Math.floor(tui.terminal.rows * 0.8)));
						if (available < 2) return [available ? "." : ""];
						const rows = body.render(available);
						total = rows.length;
						const chrome = height >= 3;
						pageSize = Math.max(1, height - (chrome ? 2 : 0));
						if (newest) {
							offset = total - newest.render(available).length;
							newest = undefined;
						}
						clamp();
						const visible = rows.slice(offset, offset + pageSize);
						if (!chrome) return visible;
						title.setText(`日本語訳 ${Math.min(offset + 1, total)}–${Math.min(offset + pageSize, total)}/${total}`);
						return [title.render(available)[0] ?? "", ...visible, help.render(available)[0] ?? ""];
					},
					handleInput(data) {
						if (data === "\x1b" || keybindings.matches(data, "tui.select.cancel")) {
							done();
							return;
						}
						if (keybindings.matches(data, "tui.select.up")) offset--;
						else if (keybindings.matches(data, "tui.select.down")) offset++;
						else if (keybindings.matches(data, "tui.select.pageUp")) offset -= pageSize;
						else if (keybindings.matches(data, "tui.select.pageDown")) offset += pageSize;
						else if (keybindings.matches(data, "tui.editor.cursorLineStart")) offset = 0;
						else if (keybindings.matches(data, "tui.editor.cursorLineEnd")) offset = total;
						else return;
						clamp();
						tui.requestRender();
					},
					invalidate() {
						body.invalidate();
						title.invalidate();
						help.invalidate();
					},
				};
			}, {
				overlay: true,
				overlayOptions: { width: "100%", maxHeight: "80%", anchor: "center" },
				signal: abort.signal,
			}).catch((error: unknown) => {
				if (!abort.signal.aborted) throw error;
			}).finally(() => {
				if (reader?.abort === abort) reader = undefined;
			});
			reader = { promise, abort };
			return promise;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			reader?.abort.abort();
			if (enabled) ui.setWidget(WIDGET_KEY, undefined);
			enabled = false;
			requestRender = undefined;
		},
	};
}
