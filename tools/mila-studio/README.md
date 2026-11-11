# mila-studio

Local Mastra Studio for Mila. It is dev only, has its own package and lockfile, and is never part of the root
install or the server image.

```bash
npm --prefix tools/mila-studio ci   # once (again whenever this folder's package-lock.json changes)
npm run mila:studio                 # from the repo root: regenerates the catalogue, then serves http://127.0.0.1:4111
```

The model is scripted (no provider calls), the tools are stubs, and the athlete is a fake test pass. Telemetry is off
and no `.env` is read. See [docs/dev/mastra-studio.md](../../docs/dev/mastra-studio.md) for the details, the real-model
opt-in and the licence note.
