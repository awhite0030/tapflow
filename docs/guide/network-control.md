# Network Control

Pressing the network control button in the toolbar takes the simulator or emulator offline, and pressing it again brings it back online. Offline banners, retry handling and anything else that only appears with no connection can be checked from the browser.

The button works per simulator or emulator. Other devices running on the same agent Mac, and the agent Mac's own network, are unaffected.

## Localhost is not cut

A dev server such as Metro reaches the device over the agent Mac's loopback, so it stays connected while the device is offline. You can watch offline behaviour with a debug build still attached.

## iOS needs the network extension

Network control on an iOS simulator requires the tapflow network extension to be installed once **on the agent Mac**. It installs on the Mac, not in the simulator: a simulator has no radio to switch off and shares the Mac's network.

Installing and approving it happens on the agent Mac and needs administrator rights. The steps are in [Troubleshooting](/guide/troubleshooting#network-not-set-up).

::: warning A hybrid app's WebView draws no offline banner
Screens running inside a WebView are not reached by the offline notification, so no banner appears. This is a known limitation. The WebView's own network requests fail like any other, so confirm offline behaviour on those screens by the failed requests rather than by a banner.
:::

::: tip Error codes differ from a real device
An iOS simulator reports `NSURLErrorNetworkConnectionLost` (`-1005`), not the `NSURLErrorNotConnectedToInternet` (`-1009`) a real device in airplane mode gives, so if your app branches on the error code, check that it handles both.
:::
