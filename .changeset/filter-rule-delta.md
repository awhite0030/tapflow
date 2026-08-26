---
"@tapflowio/ios-agent": patch
"tapflow": patch
---

Stop a second tapflow agent from putting the first one's devices back online, and refuse the configuration that made it possible.

The iOS filter rule is host-wide, and the agent wrote its **whole** offline set on every run — so the host replaced the rule with it. `arm()` runs on every device boot, and a freshly started agent knows of no offline device: starting a second agent therefore put every device the first had taken offline back online, silently, while that tester watched an offline control over an app whose traffic was working. The rule is now changed by a delta the caller names, so an agent removes nothing it was not asked about. The cleanup the whole-set write provided is kept in a more precise form: arming a device names that device, so a rule left behind by a dead process is cleared when that device next boots.

`tapflow agent start` also refuses when a tapflow agent for the same platform is already running on the Mac, and says so. One agent manages every simulator on its machine — the relay already treats two as one, since agent identity there is the machine's hardware id plus the platform — so the second one was never a supported setup; it just failed later and without a sentence. Nothing changes for the ordinary case of many simulators and many testers on one agent.

And the filter's container app now exits non-zero on an argument it does not recognise. It used to fall through to writing an empty rule, so a newer agent asking an older installed app a question it could not answer — `--confirm` — did not get a refusal, it **erased the rule**.
