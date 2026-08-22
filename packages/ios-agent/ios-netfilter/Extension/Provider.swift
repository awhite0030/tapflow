import NetworkExtension
import Darwin
import os.log

// Layer 1: content filter (NEFilterDataProvider). Measured to capture simulator app flows where the
// transparent proxy (app-proxy flow layer) could not. See .work/2026-08-22-ios-transparent-proxy-plan.md.
//
// per-UDID: a flow carries a bundle id, never which simulator it belongs to. Every process inside a booted
// simulator is a child of that simulator's `launchd_sim`, and the UDID appears in exactly ONE observable
// place — launchd_sim's arguments:
//
//   launchd_sim /Users/<u>/Library/Developer/CoreSimulator/Devices/<UDID>/data/var/run/launchd_bootstrap.plist
//
// It is NOT in the executable path (simulator binaries, launchd_sim included, live in the shared
// simruntime) and NOT in the working directory (measured: "/"). So a flow is attributed by walking its
// process up to the ancestor whose parent is the host launchd, confirming that ancestor is launchd_sim,
// and reading the UDID out of its arguments. Host-Mac flows stop at their own top-level process, whose
// path is not launchd_sim, and resolve to nil.
private let log = OSLog(subsystem: "dev.tapflow.netfilter", category: "filter")

// The offline set arrives through NEFilterProviderConfiguration.vendorConfiguration, written by the
// container app (Open Q#3). Loopback needs no exception: measured, a content filter never sees loopback
// flows at all — a simulator in the offline set still reaches the host's 127.0.0.1 (which is where Metro
// runs) while every external flow of the same simulator is dropped.
//
// It is read per flow rather than cached at startFilter, because whether a change reaches a RUNNING
// provider is the open question this build measures: a toggle that only takes effect on restart is a
// different feature from one that takes effect now.
private func offlineUDIDs(_ config: NEFilterProviderConfiguration) -> Set<String> {
    guard let raw = config.vendorConfiguration?["offlineUDIDs"] as? [String] else { return [] }
    return Set(raw)
}

// Logs the offline set the moment it changes, so the measurement can tell a live update from a restart
// (a restart shows up as a new provider pid plus a startFilter line).
private final class RuleWatch {
    private var last: Set<String>?
    private let lock = NSLock()

    func noteIfChanged(_ current: Set<String>) {
        lock.lock(); defer { lock.unlock() }
        guard last != current else { return }
        os_log("offline set now %{public}@ (was %{public}@)", log: log, type: .default,
               current.sorted().joined(separator: ","), last?.sorted().joined(separator: ",") ?? "<unset>")
        last = current
    }
}

private let ruleWatch = RuleWatch()

// **An established connection cannot be cut, and this is where that was settled.**
//
// `.drop()` in `handleNewFlow` only ever reaches a NEW flow. A connection the app already holds — and
// `URLSession` holds one for a whole session — carries every later request without ever asking again,
// so a tester who goes offline mid-session leaves the app still talking. Apple is explicit that the
// decision is one-way: "Once you've allowed a connection to proceed, there's no way to go back on
// that decision. That's true for both content filter and transparent proxy."
// (https://developer.apple.com/forums/thread/710166)
//
// The one escape the framework offers is to never allow it: keep returning a data verdict so the flow
// stays under the filter. That was built and measured, and `peekBytes` — "the number of bytes after
// the end of the bytes passed that the filter wants to see in the next call" — makes it unusable:
//
//   peek 8192  →      0 data callbacks. An HTTP request is a few hundred bytes and never reaches the
//                     threshold, so the toggle never gets a chance to touch the flow.
//   peek 1     →  815,869 data callbacks in one 40-second run, one byte each. The drop does land, and
//                     it takes every simulator's throughput with it — the *control* simulator, which
//                     no rule named, timed out on every request.
//
// So the flow verdict is final here on purpose. What an app in a session sees is: new connections
// fail, and the connection it is holding keeps working until it is replaced. Closing that gap needs a
// mechanism inside the app process, not on the host — see the plan.

class Provider: NEFilterDataProvider {
    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
        os_log("startFilter entered, offline=%{public}@", log: log, type: .default,
               offlineUDIDs(filterConfiguration).sorted().joined(separator: ","))
        let settings = NEFilterSettings(rules: [], defaultAction: .filterData)
        apply(settings) { error in
            if let error {
                os_log("startFilter failed: %{public}@", log: log, type: .error, error.localizedDescription)
            } else {
                os_log("startFilter applied OK", log: log, type: .default)
            }
            completionHandler(error)
        }
    }

    override func stopFilter(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        os_log("stopFilter reason=%{public}d", log: log, type: .default, reason.rawValue)
        completionHandler()
    }

    override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        let token = flow.sourceAppAuditToken
        let pid = token.flatMap(pidFromAuditToken) ?? -1
        let asid = token.map(asidFromToken) ?? 0
        let udid = pid > 0 ? (udidForPID(pid) ?? "-") : "-"
        let rule = offlineUDIDs(filterConfiguration)
        ruleWatch.noteIfChanged(rule)

        // A host flow — the user's own browser, mail, everything else on this Mac. Allowed outright,
        // which also ENDS filtering for it, so the data callbacks below are paid for only by the
        // simulators tapflow can be asked to cut. Host flows are the overwhelming majority.
        guard udid != "-" else {
            os_log("handleNewFlow pid=%{public}d udid=- asid=%{public}u verdict=allow(host)",
                   log: log, type: .default, pid, asid)
            return .allow()
        }

        if rule.contains(udid) {
            os_log("handleNewFlow pid=%{public}d udid=%{public}@ asid=%{public}u verdict=DROP",
                   log: log, type: .default, pid, udid, asid)
            return .drop()
        }

        os_log("handleNewFlow pid=%{public}d udid=%{public}@ asid=%{public}u verdict=allow",
               log: log, type: .default, pid, udid, asid)
        return .allow()
    }
}

// MARK: - pid → UDID

// audit_token_t is 8 x uint32 (auid, euid, egid, ruid, rgid, pid, asid, pidversion).
private func pidFromAuditToken(_ data: Data) -> pid_t? {
    guard data.count == MemoryLayout<audit_token_t>.size else { return nil }
    return data.withUnsafeBytes { pid_t(bitPattern: $0.bindMemory(to: UInt32.self)[5]) }
}

private func asidFromToken(_ data: Data) -> UInt32 {
    guard data.count == MemoryLayout<audit_token_t>.size else { return 0 }
    return data.withUnsafeBytes { $0.bindMemory(to: UInt32.self)[6] }
}

// Parent lookup goes through sysctl(KERN_PROC), which the sysext sandbox permits — measured against both
// a host process (a Chrome helper resolved to the Chrome browser process) and simulator flows (all 231
// resolved to launchd_sim).
private func ppidSysctl(_ pid: pid_t) -> pid_t? {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    var kp = kinfo_proc()
    var len = MemoryLayout<kinfo_proc>.stride
    guard sysctl(&mib, u_int(mib.count), &kp, &len, nil, 0) == 0, len > 0 else { return nil }
    return kp.kp_eproc.e_ppid
}

private func pidPath(_ pid: pid_t) -> String? {
    var buf = [CChar](repeating: 0, count: 4096) // PROC_PIDPATHINFO_MAXSIZE, not exported to Swift
    return proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 ? String(cString: buf) : nil
}

// The argument vector via sysctl(KERN_PROCARGS2). The buffer is a packed run of NUL-separated strings
// (argc, exec path, argv, envp); we only search it for a substring, so NULs become spaces instead of
// parsing that layout. KERN_ARGMAX sizes the buffer — a NULL-oldp size probe is not reliable here.
private func procArgs(_ pid: pid_t) -> String? {
    var argmaxMib: [Int32] = [CTL_KERN, KERN_ARGMAX]
    var argmax: Int32 = 0
    var argmaxLen = MemoryLayout<Int32>.size
    guard sysctl(&argmaxMib, 2, &argmax, &argmaxLen, nil, 0) == 0, argmax > 0 else { return nil }

    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var buf = [UInt8](repeating: 0, count: Int(argmax))
    var len = Int(argmax)
    guard sysctl(&mib, u_int(mib.count), &buf, &len, nil, 0) == 0, len > 0 else { return nil }

    let text = buf.prefix(len).map { $0 == 0 ? UInt8(0x20) : $0 }
    return String(decoding: text, as: UTF8.self)
}

// .../Devices/<UDID>/... — a UDID is a 36-character uppercase UUID.
private func extractUDID(from text: String) -> String? {
    guard let marker = text.range(of: "/Devices/") else { return nil }
    let udid = text[marker.upperBound...].prefix { $0 != "/" }
    return udid.count == 36 ? String(udid) : nil
}

// launchd_sim outlives every flow of the simulator it hosts, so caching by its pid holds for the whole
// boot and the per-flow cost stays at the parent walk. Only positive results are cached: a host flow is
// rejected by the launchd_sim path check before any argument read, so it never pays for the miss.
private final class UDIDCache {
    private var byRootPID: [pid_t: String] = [:]
    private let lock = NSLock()

    func lookup(_ pid: pid_t) -> String? {
        lock.lock(); defer { lock.unlock() }
        return byRootPID[pid]
    }

    func store(_ pid: pid_t, _ udid: String) {
        lock.lock(); defer { lock.unlock() }
        byRootPID[pid] = udid
    }
}

private let udidCache = UDIDCache()

private func udidForPID(_ pid: pid_t) -> String? {
    guard let root = simulatorRootPID(pid) else { return nil }
    if let cached = udidCache.lookup(root) { return cached }
    guard let udid = procArgs(root).flatMap(extractUDID) else { return nil }
    udidCache.store(root, udid)
    return udid
}

// The top-level ancestor (parent is the host launchd) if it could be a launchd_sim. A known path that is
// not launchd_sim rules the flow out before any argument read; an unreadable path falls through, because
// the UDID pattern in the arguments is the stronger check and there is no reason to lose a flow to it.
// The loop is bounded against a cycle in the reported parent chain.
private func simulatorRootPID(_ pid: pid_t) -> pid_t? {
    var current = pid
    for _ in 0..<32 {
        guard let ppid = ppidSysctl(current) else { return nil }
        if ppid <= 1 {
            if let path = pidPath(current), !path.hasSuffix("/launchd_sim") { return nil }
            return current
        }
        current = ppid
    }
    return nil
}
