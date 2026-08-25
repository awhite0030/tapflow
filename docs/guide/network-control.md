# Network Control

Pressing the network control button in the toolbar takes the simulator or emulator offline, and pressing it again brings it back online. Offline banners, retry handling and anything else that only appears with no connection can be checked from the browser.

The button works per simulator or emulator. Other devices running on the same agent Mac, and the agent Mac's own network, are unaffected.

**A request it cannot carry out is refused.** Telling the app it is offline without actually blocking its traffic would leave every request succeeding behind a screen that says otherwise, and offline behaviour checked in that state has not been checked at all. So tapflow applies all of it or none of it, and the button says why.

## Localhost is not cut

A dev server such as Metro reaches the device over the agent Mac's loopback, so it stays connected while the device is offline. You can watch offline behaviour with a debug build still attached.

## iOS needs the network extension

Network control on an iOS simulator requires the tapflow network extension to be installed once **on the agent Mac**. It installs on the Mac, not in the simulator: a simulator has no radio to switch off and shares the Mac's network.

tapflow does not distribute this extension yet. How to obtain it, and the install and approval steps, are in [Troubleshooting](/guide/troubleshooting#network-not-set-up); they happen on the agent Mac and need administrator rights.

## When the button says why

A device that cannot be taken off the network draws the button in the failure colour along with what to do about it.

| What the button says | What to do |
|---|---|
| Launch an app | Launch an app through tapflow. Traffic can already be cut; telling the app needs it running under tapflow |
| Restart the device | Restart the device. Nothing was set up for it on this boot |
| It could not be confirmed — try again | Press it again. This appears while a device is booting, or when the connection to it drops briefly |
| The device did not change when asked | Press it again. If it keeps happening, that device will not take the setting — use another one |
| This Mac is not set up for it | See [iOS needs the network extension](#ios-needs-the-network-extension) above. It is an install step on the agent Mac |

**Pressing again is only worth it where it says to try again.** The rest answer the same way however many times they are pressed.

If a notice tells you the device went back on the network on its own while you were checking, the offline behaviour you have checked so far needs checking again. [Troubleshooting](/guide/troubleshooting#network-stopped) covers the cause and what to do.

::: warning A hybrid app's WebView draws no offline banner
Screens running inside a WebView are not reached by the offline notification, so no banner appears. This is a known limitation. The WebView's own network requests fail like any other, so confirm offline behaviour on those screens by the failed requests rather than by a banner.
:::

::: tip Error codes differ from a real device
An iOS simulator reports `NSURLErrorNetworkConnectionLost` (`-1005`), not the `NSURLErrorNotConnectedToInternet` (`-1009`) a real device in airplane mode gives, so if your app branches on the error code, check that it handles both.
:::
