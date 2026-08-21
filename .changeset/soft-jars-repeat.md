---
"@tapflowio/relay": patch
---

The dashboard's icon set moved to lucide-react 1.x, from 0.577.

Housekeeping ahead of the network control for #607, which will use `radio-off` — an icon added in lucide v1.6.0. Not a necessity: 0.577 already carries `wifi-off`, `plane`, `signal` and `antenna`, and the slash could have been drawn by hand. It is a preference for the glyph that says "no radio at all", which is what airplane mode does, and doing the bump now keeps it out of the diff that adds the control.

Nothing you interact with changes. Forty-nine of the fifty icons in use are drawn from identical data; the fiftieth is the book on the sidebar's Docs link, and it has been redrawn — same book, rounder corners. All the JS the dashboard ships grows by 30 bytes.
