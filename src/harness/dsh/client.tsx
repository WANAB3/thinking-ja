import { type ReactNode, useEffect, useState } from "react";

/*
 * DeepSeek Harness, browser half: replaces Chat's entry in the
 * `conversation.chat.reasoning.body` Slot. It draws the original reasoning
 * through Chat's own `conversation.chat.reasoning.content` Factory, then,
 * once the reasoning stopped streaming, the Japanese translation the Host
 * half returns, drawn through the same Factory. The Slot is only mounted while
 * a reasoning row is expanded, so collapsed rows cost nothing.
 */

/** Must match TRANSLATE_PATH in host.ts. */
const TRANSLATE_PATH = "/_thinking-ja/translate";

/** What Chat passes to a `conversation.chat.reasoning.body` entry, as far as this one reads. */
type BodyProps = {
	text: string;
	rawText: string;
	running: boolean;
	renderFactorySlot: (name: "conversation.chat.reasoning.content", props: { text: string; running: boolean }) => ReactNode;
};

function ThinkingJaBody({ text, rawText, running, renderFactorySlot }: BodyProps) {
	const [ja, setJa] = useState<string>();
	useEffect(() => {
		setJa(undefined);
		if (running || !rawText.trim()) return;
		const abort = new AbortController();
		fetch(TRANSLATE_PATH, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: rawText }),
			signal: abort.signal,
		})
			.then((response) => (response.ok ? response.json() : undefined))
			.then((body: unknown) => {
				const translated = body && typeof body === "object" && "ja" in body ? body.ja : undefined;
				if (!abort.signal.aborted && typeof translated === "string") setJa(translated);
			})
			.catch(() => {
				// Aborted on collapse, or the Host half failed and logged why: show the original only.
			});
		return () => abort.abort();
	}, [rawText, running]);

	return (
		<>
			{renderFactorySlot("conversation.chat.reasoning.content", { text, running })}
			{ja === undefined ? null : (
				<div data-thinking-ja="" style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed currentColor", opacity: 0.8 }}>
					{renderFactorySlot("conversation.chat.reasoning.content", { text: ja, running: false })}
				</div>
			)}
		</>
	);
}

/** The browser Context's Slot registry, as far as this plugin uses it. */
type ClientContext = {
	slots: {
		inject(name: "conversation.chat.reasoning.body", callback: () => unknown): unknown;
		register(options: { name: "conversation.chat.reasoning.body"; priority: number }, component: typeof ThinkingJaBody): unknown;
	};
};

export const name = "thinking-ja";
export const inject = ["slots"];

/** Below Chat's own entry (100), so this one is elected while installed. */
export function apply(ctx: ClientContext) {
	ctx.slots.inject("conversation.chat.reasoning.body", () =>
		ctx.slots.register({ name: "conversation.chat.reasoning.body", priority: 50 }, ThinkingJaBody),
	);
}
