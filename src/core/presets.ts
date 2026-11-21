import type { TranslatorTemplate } from "./config.ts";

/**
 * Request templates for translation-specialized weights, each checked end to
 * end against llama-server. A config entry names one with `preset` and may
 * override any field.
 */
export const PRESETS: Record<string, TranslatorTemplate> = {
	/**
	 * PLaMo 3 Translate (pfnet/plamo-3-translate-*): PFML3 prompt on the
	 * completions endpoint. The context line keeps identifiers and paths as
	 * written; `form=plain` asks for だ/である style. 1500-char chunks with 8
	 * in flight match `llama-server -np 8`.
	 */
	"plamo-3-translate": {
		prompt:
			"<|plamo:tag|>dataset<|plamo:msg|>translation" +
			"<|plamo:tag|>context<|plamo:msg|>Internal reasoning notes of an AI coding assistant working in a software repository. Code identifiers, commands and file paths stay as written." +
			"<|plamo:tag|>input<|plamo:msg|>{{text}}" +
			"<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>plain<|plamo:msg|>",
		stop: ["<|plamo:tag|>", "<|plamo:bos|>"],
		chunkChars: 1500,
		concurrency: 8,
	},
	/** HY-MT1.5 (tencent/HY-MT1.5-*): the model card's prompt and sampling, on the chat endpoint. */
	"hy-mt": {
		messages: [
			{
				role: "user",
				content: "Translate the following segment into Japanese, without additional explanation.\n\n{{text}}",
			},
		],
		body: { temperature: 0.7, top_k: 20, top_p: 0.6, repeat_penalty: 1.05 },
	},
};
