---
"@tapflowio/ios-agent": patch
"tapflow": patch
---

Ship the iOS network filter with tapflow, and give the CLI the three commands that install, migrate and check it.

The filter is the one layer of the offline toggle that lives on the Mac, and until now tapflow did not distribute it — the feature was complete and unusable by anyone who could not build and sign it themselves. The signed, notarized app now travels inside `@tapflowio/ios-agent`, so `tapflow setup ios` offers it on a new machine — asked for, like every other install that command performs — and `tapflow migrate net-filter` covers a machine set up before the feature existed, or one where setup was declined.

`tapflow doctor ios` reports three things separately: installed, approved, and **running the version this tapflow carries**. The third is not the same question as the first two — replacing an extension finishes only on restart, so the app on disk can be current while macOS still runs the old one, and that is exactly the state where the dashboard says the Mac is not set up. The version comparison therefore reads what macOS has activated rather than what is in `/Applications`.

Installing refuses to replace a newer filter than the one it carries: `/Applications` holds one copy for the whole Mac while each install judges it by its own dependencies, so an older checkout would otherwise downgrade the filter a newer agent depends on.
