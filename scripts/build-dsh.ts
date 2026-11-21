/**
 * Builds the DeepSeek Harness plugin halves into dist/dsh.
 *
 * Host: one ESM file for Node, core bundled in. Browser: a CommonJS bundle
 * wrapped in `window.__ModuleLoader__.load({ id, factory })`, the shape DSH's
 * module loader serves to the page; `id` must equal the package name, and
 * React comes from the shell, so it stays external.
 */
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const { name } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { name: string };

await build({
	entryPoints: ["src/harness/dsh/host.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	outfile: "dist/dsh/host.js",
});

await build({
	entryPoints: ["src/harness/dsh/client.tsx"],
	bundle: true,
	platform: "browser",
	format: "cjs",
	target: "es2020",
	jsx: "automatic",
	jsxImportSource: "react",
	external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"],
	outfile: "dist/dsh/client.js",
	banner: {
		js: `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(name)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n`,
	},
	footer: { js: "\n\t\treturn module.exports;\n\t}\n});\n" },
});
