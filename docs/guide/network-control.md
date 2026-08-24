# Network Control

The network button in the device toolbar takes one device offline, so offline banners, retry logic and stale cached screens — the things an app only does with no connection — can be checked from the browser.

## Using it

Press the network button in the device toolbar and that device goes offline. Press it again to bring it back.

The button works per device. However many devices a session holds, only the one you pressed is cut, and neither the other devices nor the agent Mac's own network is affected.

## What gets cut

- New connections fail.
- **Connections the app already holds are cut too**, so the app does not need restarting.
- The app notices. An app watching path status is told the path is gone, so its offline banner actually appears.
- The status bar stops showing service.

**Localhost stays up.** A dev server such as Metro reaches the device over the Mac's loopback, so it stays connected while the device is offline — you can watch offline behaviour with a debug build still attached.

::: tip iOS error codes differ from a real device
An iOS simulator reports `NSURLErrorNetworkConnectionLost` (`-1005`), not the `NSURLErrorNotConnectedToInternet` (`-1009`) a real device in airplane mode gives. If your app branches on the error code, check that it handles both.
:::

## Requirements

- **Android** — none. It puts the emulator into airplane mode.
- **iOS** — the tapflow network extension has to be installed once on the agent Mac.

An iOS simulator has no radio to switch off. It is a process on your Mac sharing your Mac's network stack, so cutting the traffic of one simulator and nothing else takes a system extension.

Installing it is a one-time job for an administrator at the Mac running the agent; someone connected from a browser cannot do it. The steps are in [Troubleshooting](/guide/troubleshooting#network-not-set-up).

::: warning Without the extension, iOS offline is not real
The button still presses on a Mac where the extension is not installed. The app draws its offline screen while its requests keep succeeding. Confirm the extension is installed before concluding that retry or offline behaviour has been verified.
:::

## Troubleshooting

**An iOS device does not go offline**

- Check that the extension is installed and approved on the agent Mac. The steps are in [Troubleshooting](/guide/troubleshooting#network-not-set-up).

**Some requests still succeed while offline**

- Requests to localhost are let through deliberately. If anything else succeeds, the extension is not installed.

See also: [Troubleshooting](/guide/troubleshooting).
