# Local Mastra Studio (dev only)

Mastra Studio is a local web UI where you can chat with Mila, see her instructions and tools, and watch each tool call.
It runs on your machine only. It is never hosted, never deployed and never part of the server install or image.

## Run it

Do this once (and again whenever `tools/mila-studio/package-lock.json` changes):

```bash
npm --prefix tools/mila-studio ci
```

Then, from the repo root:

```bash
npm run mila:studio
```

This runs `npm run catalogue` first, so Studio loads instructions and tools that match the repo. It then starts
`mastra dev` on **http://127.0.0.1:4111** (the API is under `/api`). Open it and pick the **Mila** agent. Stop it with
Ctrl+C.

## What it shows

- **Instructions.** The exact text `buildMilaInstructions({ surface: "chat" })` builds, read from
  `docs/catalogue/prompt-register.json`.
- **Tools.** The tools of the `chat` pass, with their real registry names, descriptions and argument schemas, read from
  `docs/catalogue/catalogue.json`. Set `STUDIO_PASS=waitlist` (or another pass id) to load a different pass.
- **The athlete.** A fake pass for the test athlete `dd1a8a80-d31b-423a-a572-9d146716cb0f`. It is not signed, and
  nothing checks it.

Studio imports no server code. It reads only those two generated files, so it needs nothing from the root install.

## What is NOT real (by design)

- **The model.** By default Mila runs on a scripted model, so no provider is ever called. Type
  `/tool <name> {json args}` (for example `/tool recall_facts {}`) to make her call a tool. Anything else is echoed back.
- **The tools.** Every tool is a stub that returns a fixed `studio_stub` result. Stubs read nothing, write nothing and
  never touch a database. Arguments are still validated against the real schema.
- **Off:** no storage, no memory, no observability exporter and no EE features. Telemetry is off
  (`MASTRA_TELEMETRY_DISABLED=1`). No `.env` file is loaded (`MASTRA_SKIP_DOTENV=1`). The server binds to `127.0.0.1`
  only. `tools/mila-studio/run.mjs` sets all three on every platform.

### Opting in to a real model

This is a deliberate choice: you pay for the calls, and the tools are still stubs. Export the key in your own shell
first, because no `.env` is read:

```bash
export OPENAI_API_KEY=...            # your own key, in this shell only
STUDIO_MODEL=openai/gpt-5.1 npm run mila:studio
```

## Isolation

- `tools/mila-studio/` is its own npm package with its own `package-lock.json`. It is not a workspace of the root.
- It pins exactly: `mastra` 1.35.0 (the CLI), `@mastra/core` 1.79.0 (matching the root), `@mastra/deployer` 1.79.0
  (the one matching that core; the CLI's `^1.79.0` would otherwise resolve to a deployer that needs core 1.81), and
  `@ai-sdk/openai` 4.0.103 (only loaded on the opt-in).
- The CLI pulls in `@mastra/deployer` and `@mastra/server`. They exist only in `tools/mila-studio/node_modules`. The
  root `package-lock.json` has neither, and `server/agent/engine/engine.test.ts` fails CI if either ever appears there.
  The same test also fails if `tools/` is ever copied into the Docker image.

| Path | What |
|------|------|
| `tools/mila-studio/src/index.ts` | The Mastra entry: agent, stub tools and scripted model |
| `tools/mila-studio/run.mjs` | Starts `mastra dev` with telemetry off, no dotenv, localhost only |
| `tools/mila-studio/.mastra/`, `src/public/` | What `mastra dev` writes (gitignored) |

## Licence

Mastra is Apache-2.0, except the code under `ee/` directories, which falls under Mastra's enterprise licence. We use
none of the EE features: no licence key, no FGA, no auth providers. Studio is used locally for development only.
