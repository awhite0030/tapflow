import Foundation
import NetworkExtension

// System extensions are standalone executables and need their own entry point.
// startSystemExtensionMode() reads Info.plist NEProviderClasses and instantiates Provider.
// Content-filter probe: no XPC yet — capture is observed via the NE framework log, so the listener
// stays off. (IPCConnection is kept in the target for the later per-UDID control wiring.)
autoreleasepool {
    NEProvider.startSystemExtensionMode()
}
dispatchMain()
