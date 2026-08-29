---
"@tapflowio/relay": minor
---

perf(relay): caching + compression headers for static assets (serveStatic)

- Hashed assets (`/assets/*`): `Cache-Control: public, max-age=31536000, immutable`
- `index.html`: `no-cache`
- Prefer pre-compressed `.br` / `.gz` files when present
- Combine with the async-stat cleanup (see P2 housekeeping issue)
