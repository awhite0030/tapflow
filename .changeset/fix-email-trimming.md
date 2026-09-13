---
"@tapflowio/relay": patch
---

Fix email trimming mismatch between boot initialization and HTTP path by introducing a normalization policy that lowercases and trims email addresses at the source.
