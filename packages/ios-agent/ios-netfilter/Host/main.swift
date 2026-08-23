import Foundation
import NetworkExtension
import SystemExtensions
import os.log

// Container app: installs the content-filter system extension and enables the filter via NEFilterManager.
// (Content filter, not transparent proxy — the proxy couldn't see simulator flows. See Provider.swift.)
// Capture is observed via the NE framework log; no XPC needed for this probe.

private let log = OSLog(subsystem: "dev.tapflow.netfilter", category: "host")
private let extensionBundleID = "dev.tapflow.netfilter.ext"

/**
 * **Every failure exits with its own code, and none of them exits 0.**
 *
 * This used to `exit(0)` from the configuration completion whether the preferences loaded, saved, or
 * failed. A user who declines the filter in System Settings makes the save fail, and the process
 * still reported success — so the agent wrote a rule nothing was enforcing and the control said
 * `available: true` over a kernel dropping nothing.
 *
 * **Zero still is not a confirmation that the rule is being enforced.** It now means the save was
 * accepted — every exit runs from inside a completion handler — and no further. The framework hands
 * `vendorConfiguration` to the running provider afterwards, on its own schedule and with no
 * acknowledgement coming back, and the whole run returns in 27ms (measured). So the claim an exit
 * status can carry here is "nothing refused", which is smaller than "it works" and is the reason the
 * agent decides `available` from the dylib's verdict instead of from this. Reporting layer 1's own
 * health needs an artefact the agent can read, which is a separate issue and not this.
 */
private enum ExitCode: Int32 {
    case ok = 0
    case activationFailed = 1
    case loadPreferencesFailed = 2
    case savePreferencesFailed = 3
    case needsUserApproval = 4
    case completesAfterReboot = 5
}

private func die(_ code: ExitCode, _ why: String) -> Never {
    hlog("exiting \(code.rawValue): \(why)")
    exit(code.rawValue)
}

/// How long to wait for a user who has been sent to System Settings. Without a bound the process sits
/// in its run loop forever, and an agent that waits on it waits with it.
private let approvalDeadline: TimeInterval = 30

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
        // Approval is a human walking to System Settings, and it may never come. Nothing else here
        // ends the run loop on that path, so without this the process — and anything waiting on it —
        // stays for the life of the machine.
        DispatchQueue.main.asyncAfter(deadline: .now() + approvalDeadline) {
            die(.needsUserApproval, "no approval within \(Int(approvalDeadline))s — approve the extension in System Settings and try again")
        }
    }

    func request(_ request: OSSystemExtensionRequest,
                 didFinishWithResult result: OSSystemExtensionRequest.Result) {
        hlog("sysext activated (result \(result.rawValue))")
        // **A result is not automatically a success.** `willCompleteAfterReboot` says the extension
        // this build installed is not the one running, so writing a rule now configures a filter that
        // will not enforce it until the machine restarts — reported as working the whole time.
        if result == .willCompleteAfterReboot {
            die(.completesAfterReboot, "the extension will not run until this Mac is restarted")
        }
        // The earlier transparent-proxy attempt left a NETunnelProvider config behind, and
        // NETunnelProvider keeps its provider PROCESS alive as long as that config exists — which is
        // why replacing the bundle never swapped in the new content-filter code. Remove it first so
        // the stale provider exits, then enable the filter (which spawns the provider fresh).
        // Exit once the rule is written. The provider keeps running and the configuration persists, so
        // a resident container app would buy nothing — and leaving one behind is what made `open` a
        // silent no-op on the next invocation (it activates a running app instead of re-running main).
        cleanupOldProxy { [offline] in
            configureFilter(offline: offline)
        }
    }

    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        hlog("sysext activation FAILED: \((error as NSError).domain) code=\((error as NSError).code): \(error.localizedDescription)")
        die(.activationFailed, error.localizedDescription)
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
private func configureFilter(offline: [String]) {
    let manager = NEFilterManager.shared()
    manager.loadFromPreferences { error in
        if let error {
            die(.loadPreferencesFailed, error.localizedDescription)
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
            // The branch that mattered: declining the filter in System Settings lands here, and it
            // used to log and exit 0 like the success beside it.
            if let error {
                die(.savePreferencesFailed, error.localizedDescription)
            }
            hlog("filter enabled, offline=\(offline)")
            exit(ExitCode.ok.rawValue)
        }
    }
}

hlog("host launched at \(Bundle.main.bundlePath) args=\(CommandLine.arguments.dropFirst())")
let host = Host(offline: parseOfflineUDIDs())
host.activate()
RunLoop.main.run()
