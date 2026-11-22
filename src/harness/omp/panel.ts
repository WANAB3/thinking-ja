import { stripVTControlCharacters } from "node:util";
import type { ExtensionUIContext, Text } from "@oh-my-pi/pi-coding-agent";
import type { Component } from "@oh-my-pi/pi-tui";

type TextHost = { Text: typeof Text };
type ReaderUI = Pick<ExtensionUIContext, "custom">;

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
 * Reserve rows from visible English before any Japanese arrives. The common
 * ASCII append path only counts the new source characters; translated tokens
 * never re-wrap the source. Non-ASCII source uses the host's Unicode wrapper.
 */
export function createInlineTranslation(
	host: TextHost,
	source: string,
	style: (line: string) => string,
	enabled: () => boolean,
): Component & { setSource(source: string): void; setTranslation(text: string, final: boolean): void } {
	const original = new host.Text("", 0, 0);
	const translated = new host.Text("", 0, 0);
	let rawSource = "";
	let hasSource = false;
	let rawAscii = true;
	let visibleAscii = true;
	let lineLengths = [0];
	let sourceDirty = true;
	let previousWidth = -1;
	let reservation = 0;
	let finalHeight = 0;
	let translation = "";
	let final = false;

	const setSource = (next: string) => {
		if (next === rawSource) return;
		const suffix = rawAscii && next.startsWith(rawSource) ? next.slice(rawSource.length) : undefined;
		if (suffix !== undefined && /^[\x20-\x7e\n]*$/.test(suffix)) {
			for (let i = 0; i < suffix.length; i++) {
				if (suffix.charCodeAt(i) === 10) lineLengths.push(0);
				else lineLengths[lineLengths.length - 1]!++;
			}
			hasSource = next.length > 0;
		} else {
			const visible = plainText(next);
			rawAscii = /^[\x20-\x7e\n]*$/.test(next);
			visibleAscii = /^[\x20-\x7e\n]*$/.test(visible);
			hasSource = visible.length > 0;
			if (visibleAscii) lineLengths = visible.split("\n").map((line) => line.length);
			else original.setText(visible);
		}
		rawSource = next;
		sourceDirty = true;
	};
	setSource(source);

	return {
		setSource,
		setTranslation(text, complete) {
			const next = plainText(text);
			if (translation !== next) {
				translation = next;
				translated.setText(next);
			}
			final = complete;
		},
		render(width) {
			if (!enabled()) return [];
			const available = columns(width);
			if (available === 0) return [];
			if (previousWidth !== available) {
				previousWidth = available;
				reservation = 0;
				finalHeight = 0;
				sourceDirty = true;
			}
			if (sourceDirty) {
				// Twenty percent narrower than the real column budget leaves room
				// for Japanese and English word-wrap slack without a fixed cap.
				const estimateWidth = Math.max(1, Math.floor(available * 0.8));
				const estimated = !hasSource ? 0 : visibleAscii
					? lineLengths.reduce((rows, length) => rows + Math.max(1, Math.ceil(length / estimateWidth)), 0)
					: original.render(Math.max(2, estimateWidth)).length;
				reservation = Math.max(reservation, estimated);
				sourceDirty = false;
			}
			// A wide glyph cannot fit in one terminal column. Leave its reserved
			// space blank, retaining the original text for the next usable width.
			const wrapped = translation && available >= 2 ? translated.render(available) : [];
			if (final) finalHeight = Math.max(finalHeight, wrapped.length);
			const height = Math.max(reservation, finalHeight);
			return Array.from({ length: height }, (_, index) => {
				const row = wrapped[index];
				return row ? style(row) : "";
			});
		},
		invalidate() {
			original.invalidate();
			translated.invalidate();
			sourceDirty = true;
		},
	};
}

/**
 * The explicit reader freezes its input and uses the host's text wrapping.
 * Default keys: arrows, PageUp/PageDown, Home/End, Escape; host remaps apply.
 */
export function createTranslationReader(ui: ReaderUI, host: TextHost): {
	show(blocks: readonly string[]): Promise<void>;
	dispose(): void;
} {
	let disposed = false;
	let reader: { promise: Promise<void>; abort: AbortController } | undefined;

	return {
		show(blocks) {
			if (disposed) return Promise.resolve();
			if (reader) return reader.promise;
			const pages = blocks.map(plainText);
			const snapshot = pages.join("\n\n") || "翻訳はまだありません。";
			const abort = new AbortController();
			const promise = ui.custom<void>((tui, _theme, keybindings, done) => {
				const body = new host.Text(snapshot, 0, 0);
				// Start at the newest translated block, not the session's beginning.
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
		},
	};
}
