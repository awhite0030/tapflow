---
"@tapflowio/ios-agent": patch
"@tapflowio/protocol": patch
"tapflow": patch
---

Write the injected library's verdict file atomically, so a healthy app stops reporting that its state could not be confirmed.

The library wrote the file with `fopen(path, "w")`, which truncates it in place. The agent reads that file on every `state()` call — the relay triggers one on `device:ready`, on a viewer's re-join and after every toggle — so a read landing inside the write is reachable on a session where nothing is wrong, and what it gets is half a file. The reader cannot tell that from a real answer, so the network control reported `state-unconfirmed` for no cause. It now writes beside the target and `rename`s onto it: a reader sees the whole old file or the whole new one.

The dylib is a committed prebuilt with no recorded build recipe, so `packages/ios-agent/build-nethook.sh` now holds one. Its flags were recovered from the committed binary rather than remembered, and confirmed by a rebuild whose every section matched byte for byte.

Two things that were invisible now report. `bin/libtapflow-nethook.dylib` is a committed prebuilt, and every test that exercised the network hook injected a *fake* path — so editing the source and shipping the previous binary was silent. It is now recorded against its sources like the network filter next door, with the difference stated in the guard: a failure here is the contributor's to fix, because no signing key is involved.

And the library itself had no diagnosis at all. `DYLD_INSERT_LIBRARIES` naming a path that does not exist is ignored by dyld without a word, so a damaged install launched the app unhooked and wrote no verdict — leaving the control asking the tester to launch an app through tapflow, for the whole session, while the app they launched was running in front of them. `tapflow doctor ios` now reports the library, and the agent says so instead of asking for something already done.
