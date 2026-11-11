// run.mjs — starts `mastra dev` for src/index.ts with the settings Studio must always have, on every platform:
// telemetry off, no .env loaded (the repo's .env holds real secrets), bound to 127.0.0.1 only.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(dirname(createRequire(import.meta.url).resolve("mastra/package.json")), "dist", "index.js");
const env = { ...process.env, MASTRA_TELEMETRY_DISABLED: "1", MASTRA_SKIP_DOTENV: "1", HOST: "127.0.0.1" };
const child = spawn(process.execPath, [cli, "dev", "--dir", "src"], { cwd: here, env, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
