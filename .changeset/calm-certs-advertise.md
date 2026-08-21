---
"@tapflowio/relay": patch
"tapflow": patch
---

Advertise the first teammate-ready DNS host from an imported TLS certificate in relay startup output, preferring a concrete SAN over `localhost`. DNS SANs take precedence over the legacy subject CN; certificates with unusable DNS SANs keep the safe `localhost` fallback and now explain it with a warning.
