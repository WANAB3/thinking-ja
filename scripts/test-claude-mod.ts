/**
 * Runs the Claude Code mod tests (hooks/*.test.ts) with `claude plugin test`.
 *
 * That command runs every *.test.ts under the plugin directory, node_modules
 * included, so it runs on a copy holding only the files git would ship.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const files = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root })
	.stdout.toString()
	.split("\n")
	.filter(Boolean);
const copy = mkdtempSync(join(tmpdir(), "thinking-ja-mod-"));
try {
	for (const file of files) {
		mkdirSync(dirname(join(copy, file)), { recursive: true });
		cpSync(join(root, file), join(copy, file));
	}
	const run = Bun.spawnSync(["claude", "plugin", "test", copy], { stdout: "inherit", stderr: "inherit" });
	process.exitCode = run.exitCode ?? 1;
} finally {
	rmSync(copy, { recursive: true, force: true });
}
