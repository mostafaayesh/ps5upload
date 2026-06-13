# ps5upload — Docker Web UI Stack

Run ps5upload headlessly on a home server and access the full UI from any browser on your network.

## How it works

```
Browser  ──────────►  Nginx :80  ──────────►  ps5upload-engine :19113 (loopback)
                       (SPA)         /api/*          │
                                                      │  FTX2
                                                      ▼
                                                 PS5 Console
```

- **Nginx** serves the Vite-built React frontend and reverse-proxies `/api/*` to the engine.
- **ps5upload-engine** runs on loopback inside the same container — satisfying its own loopback security guard.
- Both run in a **single container** managed by the entrypoint script.

## Quick Start

### 1. Set your PS5 IP

Edit `docker-compose.yml` and set `PS5_ADDR` to your PS5's IP:

```yaml
environment:
  PS5_ADDR: "192.168.1.50:9113"
```

### 2. Mount your game library (optional but recommended)

For large game transfers (50–100+ GB), mounting a server-side directory is far more efficient than uploading through the browser. Add a volume mount in `docker-compose.yml`:

```yaml
volumes:
  - /path/to/your/games:/games:ro
```

Then in the upload screen, type the **container path** (e.g. `/games/MyGame`) directly — no local file picker needed.

### 3. Build and run

```bash
docker compose up -d --build
```

Open **http://\<your-server-ip\>:8080** in a browser.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Host port for the Web UI |
| `PS5_ADDR` | `192.168.1.x:9113` | PS5 transfer address |
| `FTX2_BANDWIDTH_MBPS` | (unlimited) | Upload bandwidth cap (MB/s) |
| `PS5UPLOAD_ENGINE_PORT` | `19113` | Engine listen port (internal) |

## Notes

- **Payload delivery** (`payload_send`) is not available in web mode — the PS5 payload must be loaded via another method (GoldHEN menu, ps5-payload-injector, etc.).
- **Local file browser** is not available in web mode. Use mounted volumes for server-side paths or type paths manually.
- Persistence (upload queue, playlists, resume tx-ids) is stored in **browser localStorage**.

## Port

By default, the Web UI is served on host port `8080`. You can configure it by setting the `PORT` environment variable in your `.env` file (e.g. `PORT=80`).
