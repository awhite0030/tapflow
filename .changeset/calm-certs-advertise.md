---
"@tapflowio/relay": patch
"tapflow": patch
---

Advertise the concrete DNS host from an imported TLS certificate in relay startup output. DNS SANs take precedence over the legacy subject CN; certificates with only wildcard or IP SANs keep the safe `localhost` fallback.
