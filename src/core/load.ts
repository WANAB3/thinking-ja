import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Config, parseConfig } from "./config.ts";

/** `$THINKING_JA_CONFIG`, else `$XDG_CONFIG_HOME/thinking-ja/config.json`, else `~/.config/thinking-ja/config.json`. */
export const configPath = (env: Record<string, string | undefined> = process.env): string =>
	env.THINKING_JA_CONFIG ||
	join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "thinking-ja", "config.json");

/** The config at `path`; undefined when the file does not exist. Throws on malformed content, naming the field. */
export const loadConfig = async (path = configPath()): Promise<Config | undefined> => {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	return parseConfig(JSON.parse(raw));
};
