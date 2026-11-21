#!/usr/bin/env node
import { parseArgs } from "node:util";
import { chunkPlan, translateBlock, translatorAttempts } from "./core/block.ts";
import { fetchPost } from "./core/http.ts";
import { configPath, loadConfig } from "./core/load.ts";
import { follow } from "./viewer/watch.ts";
import { SOURCES } from "./viewer/sources.ts";

const USAGE = `thinking-ja: Japanese translations of coding-agent thinking, by a local translation model

Usage:
  thinking-ja watch <${Object.keys(SOURCES).join("|")}> [--cwd DIR] [--file PATH] [--backlog N] [--original]
      Follow the harness's transcript for DIR (default: the current directory)
      and print a translation of every new thinking block.
        --file PATH    follow this transcript instead of the newest one for DIR
        --backlog N    also translate the last N blocks already in the transcript
        --original     print the original text above each translation
  thinking-ja translate
      Translate stdin with the configured translators (checks the config).

Config: ${configPath()}`;

const main = async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      file: { type: "string" },
      backlog: { type: "string" },
      original: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, harness] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }

  const config = await loadConfig();
  if (!config?.translators.length) {
    console.error(`thinking-ja: ${configPath()} に translators がありません。README の設定例を参照してください。`);
    process.exitCode = 1;
    return;
  }
  const attempts = translatorAttempts(config.translators, fetchPost);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());

  if (command === "translate") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const ja = await translateBlock(Buffer.concat(chunks).toString("utf8").trim(), {
      attempts,
      ...chunkPlan(config.translators),
      signal: controller.signal,
    });
    if (ja !== undefined) console.log(ja);
    return;
  }

  if (command === "watch") {
    const source = harness === undefined ? undefined : SOURCES[harness];
    if (!source) {
      console.error(`thinking-ja: watch needs one of: ${Object.keys(SOURCES).join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const backlog = Number(values.backlog ?? 0);
    await follow({
      source,
      attempts,
      ...chunkPlan(config.translators),
      file: values.file,
      cwd: values.cwd ?? process.cwd(),
      env: process.env,
      backlog: Number.isInteger(backlog) && backlog > 0 ? backlog : 0,
      original: values.original,
      write: (line) => console.log(line),
      signal: controller.signal,
    });
    return;
  }

  console.error(USAGE);
  process.exitCode = 1;
};

await main();
