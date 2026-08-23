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

/**
 * How long to wait for a user who has been sent to System Settings.
 *
 * **Sized for the caller that can actually approve, which is not the agent.** `SimulatorNetwork`
 * kills this process at 15s, so approval never completes on that path and exit 4 never reaches it —
 * the agent's own timeout is what bounds it there, and the tester is not looking at a terminal
 * anyway. The caller this serves is a person running the binary by hand to install the filter, and
 * for them the number has to cover opening System Settings and authenticating. Shortening it to fit
 * under the agent's ceiling would only kill approvals that were about to succeed.
 *
 * The bound exists at all because nothing else ends the run loop on that path.
 */
private let approvalDeadline: TimeInterval = 120

/**
 * The host's log, and **not a temporary one** — it was labelled TEMP while it was a probe and then
 * shipped, which is how a debugging aid becomes an unbounded file nobody owns.
 *
 * It exists because `os_log` from these processes does not surface in this host's `log show`
 * (measured), and the exit reasons above have nowhere else to go: the agent `exec`s this binary and
 * a code alone does not say *which* preference failed or what the framework said about it. #639,
 * which is about reporting layer 1's health, will read from here rather than invent a channel.
 *
 * The host runs as uid 501, so `/tmp` is writable here. The system extension is root and cannot
 * write it; its own lines come through the NE framework log instead.
 *
 * **Bounded, because nothing else bounds it.** `arm()` runs on every device boot, so this appends a
 * handful of lines per boot for as long as the Mac is up — and while macOS clears `/tmp` across
 * restarts, it does not do so within a session. Rotating at a size the last few runs always fit
 * inside keeps the file useful for exactly what it is read for: what happened *this* time.
 */
private let logSizeLimit = 64 * 1024

private func hlog(_ s: String) {
    os_log("%{public}@", log: log, type: .info, s)
    let url = URL(fileURLWithPath: "/tmp/tapflow-netfilter-host.log")
    guard let line = (s + "\n").data(using: .utf8) else { return }
    let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
    if size > logSizeLimit { try? FileManager.default.removeItem(at: url) }
    if let fh = try? FileHandle(forWritingTo: url) { defer { try? fh.close() }; fh.seekToEndOfFile(); fh.write(line) }
    else { try? line.write(to: url) }
}

final class Host: NSObject, OSSystemExtensionRequestDelegate {
    private let offline: [String]
    /// The approval deadline, held only so both terminal callbacks can cancel it.
    private var approvalTimeout: DispatchWorkItem?

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
        // Approval is a human walking to System Settings, and it may never come.
        //
        // **Held so it can be cancelled, and cancelled the moment the request resolves.** A bare
        // `asyncAfter` cannot be called off, so it fired on a run that had already been approved and
        // was part-way through writing the rule — killing it with "no approval came" while the
        // approval was granted and the configuration was half-written. Approving takes tens of
        // seconds, so that window is the normal case for this path, not an edge of it.
        let deadline = DispatchWorkItem {
            die(.needsUserApproval, "no approval within \(Int(approvalDeadline))s — approve the extension in System Settings and run this again")
        }
        approvalTimeout = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + approvalDeadline, execute: deadline)
    }

    func request(_ request: OSSystemExtensionRequest,
                 didFinishWithResult result: OSSystemExtensionRequest.Result) {
        hlog("sysext activated (result \(result.rawValue))")
        approvalTimeout?.cancel()
        // **A result is not automatically a success**, and `willCompleteAfterReboot` is the one that
        // is not: the extension this build installed is not the one that will run until the Mac
        // restarts. It used to exit 0 here like any other result, so a tester was told the new filter
        // was in place when the old one was still the one enforcing.
        //
        // **But it must not skip the rule.** A first draft exited immediately, and that was worse
        // than the silence it replaced. This binary takes the whole offline set on every run and is
        // therefore the only way a device is put back *online* — so exiting here left the previous
        // provider running with the previous rule, still dropping, with nothing able to clear it
        // short of a reboot. The premise was wrong too: `willCompleteAfterReboot` means the old
        // extension is alive and enforcing, and it reads `vendorConfiguration` like any other.
        //
        // So the rule is written either way and only the exit code differs.
        let pendingReboot = result == .willCompleteAfterReboot
        // The earlier transparent-proxy attempt left a NETunnelProvider config behind, and
        // NETunnelProvider keeps its provider PROCESS alive as long as that config exists — which is
        // why replacing the bundle never swapped in the new content-filter code. Remove it first so
        // the stale provider exits, then enable the filter (which spawns the provider fresh).
        // Exit once the rule is written. The provider keeps running and the configuration persists, so
        // a resident container app would buy nothing — and leaving one behind is what made `open` a
        // silent no-op on the next invocation (it activates a running app instead of re-running main).
        cleanupOldProxy { [offline] in
            configureFilter(offline: offline, exitCode: pendingReboot ? .completesAfterReboot : .ok)
        }
    }

    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        approvalTimeout?.cancel()
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
private func configureFilter(offline: [String], exitCode: ExitCode) {
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
            // Not always `.ok`: the rule is written on the reboot path too, and the code is what says
            // which provider will be enforcing it.
            if exitCode == .ok { exit(ExitCode.ok.rawValue) }
            die(exitCode, "rule written, but the extension that will run it needs this Mac restarted")
        }
    }
}

hlog("host launched at \(Bundle.main.bundlePath) args=\(CommandLine.arguments.dropFirst())")
let host = Host(offline: parseOfflineUDIDs())
host.activate()
RunLoop.main.run()
