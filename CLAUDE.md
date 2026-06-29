# EufyView

Start with **[AGENTS.md](AGENTS.md)** — full onboarding (what this is, how to run, repo map, gotchas).

Deeper references:
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — server internals, HTTP endpoints, WebSocket command set, streaming pipeline, config.
- **[docs/AUTH.md](docs/AUTH.md)** — Google OAuth gate, `auth.json` schema, remote access (Tailscale Funnel / Cloudflare).

Quick facts: Node CommonJS app, **no build step**; `node main.js` serves on port `3001`. Eufy camera
viewer (P2P → FFmpeg → fMP4/MJPEG to a PWA). All client URLs are origin-relative; `auth.json` holds
secrets and is gitignored — never commit it.
