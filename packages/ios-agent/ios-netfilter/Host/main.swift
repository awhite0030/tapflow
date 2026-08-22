import Foundation
import NetworkExtension
import SystemExtensions
import os.log

// Container app: installs the content-filter system extension and enables the filter via NEFilterManager.
// (Content filter, not transparent proxy — the proxy couldn't see simulator flows. See Provider.swift.)
// Capture is observed via the NE framework log; no XPC needed for this probe.

private let log = OSLog(subsystem: "dev.tapflow.netfilter", category: "host")
private let extensionBundleID = "dev.tapflow.netfilter.ext"

// TEMP file log — os_log from these processes isn't surfacing in this host's log show. Host is uid 501,
// so /tmp works here (the sysext, as root, cannot write /tmp — its logs come via the NE framework log).
private func hlog(_ s: String) {
    os_log("%{public}@", log: log, type: .info, s)
    let url = URL(fileURLWithPath: "/tmp/tapflow-netfilter-host.log")
    guard let line = (s + "\n").data(using: .utf8) else { return }
    if let fh = try? FileHandle(forWritingTo: url) { defer { try? fh.close() }; fh.seekToEndOfFile(); fh.write(line) }
    else { try? line.write(to: url) }
}

final class Host: NSObject, OSSystemExtensionRequestDelegate {
    private let offline: [String]

    init(offline: [String]) {
        self.offline = offline
        super.init()
    }

    func activate() {
        hlog("requesting activation of \(extensionBundleID)")
        let request = OSSystemExtensionRequest.activationRequest(
            forExtensionWithIdentifier: extensionBundleID, queue: .main)
        request.delegate = self
        OSSystemExtensionManager.shared.submitRequest(request)
    }

    func request(_ request: OSSystemExtensionRequest,
                 actionForReplacingExtension existing: OSSystemExtensionProperties,
                 withExtension ext: OSSystemExtensionProperties) -> OSSystemExtensionRequest.ReplacementAction {
        .replace
    }

    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        hlog("needs user approval in System Settings")
    }

    func request(_ request: OSSystemExtensionRequest,
                 didFinishWithResult result: OSSystemExtensionRequest.Result) {
        hlog("sysext activated (result \(result.rawValue))")
        // The earlier transparent-proxy attempt left a NETunnelProvider config behind, and
        // NETunnelProvider keeps its provider PROCESS alive as long as that config exists — which is
        // why replacing the bundle never swapped in the new content-filter code. Remove it first so
        // the stale provider exits, then enable the filter (which spawns the provider fresh).
        // Exit once the rule is written. The provider keeps running and the configuration persists, so
        // a resident container app would buy nothing — and leaving one behind is what made `open` a
        // silent no-op on the next invocation (it activates a running app instead of re-running main).
        cleanupOldProxy { [offline] in
            configureFilter(offline: offline) { exit(0) }
        }
    }

    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        hlog("sysext activation FAILED: \((error as NSError).domain) code=\((error as NSError).code): \(error.localizedDescription)")
        exit(1)
    }
}

private func cleanupOldProxy(_ done: @escaping () -> Void) {
    NETransparentProxyManager.loadAllFromPreferences { managers, error in
        if let error { hlog("loadAllFromPreferences (proxy) failed: \(error.localizedDescription)") }
        let managers = managers ?? []
        if managers.isEmpty { hlog("no old proxy config"); done(); return }
        let group = DispatchGroup()
        for m in managers {
            group.enter()
            m.removeFromPreferences { err in
                if let err { hlog("remove proxy config failed: \(err.localizedDescription)") }
                group.leave()
            }
        }
        group.notify(queue: .main) {
            hlog("removed \(managers.count) old proxy config(s)")
            done()
        }
    }
}

// The offline set arrives on the command line: `TapflowNetFilter [--offline <udid>[,<udid>…]]`.
// No argument means an EMPTY set, not "leave what is there" — this binary is how the rule is changed,
// so a plain launch must clear a stale rule rather than preserve one nobody asked for.
private func parseOfflineUDIDs() -> [String] {
    let args = CommandLine.arguments
    guard let flag = args.firstIndex(of: "--offline"), flag + 1 < args.count else { return [] }
    return args[flag + 1].split(separator: ",").map(String.init).filter { !$0.isEmpty }
}

// Rule injection (Open Q#3) goes through NEFilterProviderConfiguration.vendorConfiguration — the channel
// the framework provides for exactly this. The XPC mach service never registered in the system domain,
// and this needs no service at all: the host writes the configuration, the framework hands it to the
// provider.
private func configureFilter(offline: [String], _ done: @escaping () -> Void) {
    let manager = NEFilterManager.shared()
    manager.loadFromPreferences { error in
        if let error {
            hlog("load prefs failed: \(error.localizedDescription)")
            done()
            return
        }
        // vendorConfiguration must be set on every run, not only when the configuration is first
        // created — otherwise the second invocation, the one that actually changes the rule, is a no-op.
        let config = manager.providerConfiguration ?? NEFilterProviderConfiguration()
        config.filterSockets = true
        config.filterPackets = false
        config.vendorConfiguration = ["offlineUDIDs": offline]
        manager.providerConfiguration = config
        manager.localizedDescription = "tapflow network filter"
        manager.isEnabled = true
        manager.saveToPreferences { error in
            if let error {
                hlog("save prefs failed: \(error.localizedDescription)")
            } else {
                hlog("filter enabled, offline=\(offline)")
            }
            done()
        }
    }
}

hlog("host launched at \(Bundle.main.bundlePath) args=\(CommandLine.arguments.dropFirst())")
let host = Host(offline: parseOfflineUDIDs())
host.activate()
RunLoop.main.run()
