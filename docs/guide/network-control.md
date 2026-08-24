# Taking a device off the network

Offline banners, failed retries, stale cached screens — the things your app does on a real phone in a
lift, seen from a browser. The network button in the toolbar is what does it.

**Android needs no setup.** It puts the emulator into airplane mode, which works with what tapflow
already has.

**iOS needs a one-time setup on the Mac.** This page covers that, and what the control says before it
is done.

## Why only iOS needs setup

An iOS simulator has no radio to switch off. It is processes on your Mac, **sharing your Mac's network
stack**, so "offline" is assembled from three things.

| | What it does |
|---|---|
| **1. host filter** | drops that simulator's traffic at the kernel |
| **2. injected library** | tells the app its path is gone, and cuts the connections it already holds |
| **3. status bar** | stops showing service |

**Each alone produces a result that is wrong.** With only layer 1 the traffic dies but the app believes
it is online, so no offline banner appears. With only layer 2 the app draws its offline screen while
**its requests keep succeeding** — a tester signs off on retry behaviour having confirmed nothing.

Only **layer 1** needs setting up. It is a macOS system extension (a content filter). It installs
Mac-wide, but its effect is limited to **the one simulator you toggled** — no other simulator is
affected, and neither is your Mac's own network.

## What the control says before it is set up

The network button stays where it is and says what it cannot do.

> **This Mac can't take devices offline.**
> Ask whoever runs tapflow on this Mac to set it up.

**That is a state, not a bug.** And the person who can see it in a browser cannot fix it — the setup
below has to be done by **whoever is sitting at the Mac running the agent**.

## Installing

::: warning tapflow does not distribute this extension yet
Which medium it should reach you by is being decided in
[#647](https://github.com/jo-duchan/tapflow/issues/647). A binary signed by the project that filters
traffic at the kernel is the largest thing tapflow would ask you to trust, so it is being settled as a
decision rather than by default. Until then you build it yourself, and that **needs a paid Apple
Developer account.**
:::

```sh
export DEVELOPMENT_TEAM=YOUR_TEAM_ID
packages/ios-agent/ios-netfilter/build.sh
```

| What you need | Why |
|---|---|
| A paid Apple Developer account | macOS will not load a system extension without a Developer ID signature and notarization |
| A 10-character Team ID | `DEVELOPMENT_TEAM` |
| `notarytool` credentials | The script submits for notarization. Setting them up is covered in the header of `build.sh` |

When the build finishes, put the result in `/Applications` and activate it.

```sh
cp -R packages/ios-agent/ios-netfilter/build/stapled/TapflowNetFilter.app /Applications/
/Applications/TapflowNetFilter.app/Contents/MacOS/TapflowNetFilter --install
```

## Approving it — a person has to do this

Requesting activation makes macOS raise an approval prompt. **There is no CLI equivalent for it.**

Go to **System Settings → General → Login Items & Extensions → Network Extensions** and switch the
tapflow entry on.

This is why the step has to happen **on the Mac running the agent**. Someone connected from a browser
elsewhere can click all they like; the prompt only ever appears on that Mac — which is also why the
dashboard offers no retry button.

Once approved, the command exits `0` and the network button works immediately.

## When it does not work — exit codes

`--install` and every rule write end with a distinct code per kind of failure.

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Activation failed |
| 2 | Could not read the configuration |
| 3 | Could not save the configuration |
| 4 | Nobody approved it within 120 seconds — approve it in System Settings and run it again |
| 5 | The Mac has to be restarted for this to finish |
| 6 | The system extension manager gave no answer within 45 seconds |

Logs are at `/tmp/tapflow-netfilter-host.log`.

## Removing it

The extension is registered separately from the app in `/Applications`, so deleting the app is not
enough.

```sh
systemextensionsctl list
```

Find `dev.tapflow.netfilter.ext` in the list, then switch it off in the same place in System Settings.
A version you replaced or removed stays listed as `waiting to uninstall on reboot` **until you restart
the Mac** — that is normal.

## What you are trusting

This extension **sees network flows at the kernel and drops them.** It installs Mac-wide and runs as
root. That is the largest thing tapflow asks you to trust, so it is stated plainly.

- **It does not read what is in a flow.** It works out which simulator the flow belongs to, and drops
  it if that simulator is marked offline. That is all
- **It sends nothing anywhere.** As with the rest of tapflow, app data does not leave your network
- **The source is in `packages/ios-agent/ios-netfilter/`.** Building it yourself is the only route
  today, so the only thing running on your Mac is the thing you signed
