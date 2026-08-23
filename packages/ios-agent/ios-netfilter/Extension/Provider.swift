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

    /// Returns whether the rule moved, which is the one edge worth writing the heartbeat on
    /// immediately rather than at the next tick.
    @discardableResult
    func noteIfChanged(_ current: Set<String>) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard last != current else { return false }
        os_log("offline set now %{public}@ (was %{public}@)", log: log, type: .default,
               current.sorted().joined(separator: ","), last?.sorted().joined(separator: ",") ?? "<unset>")
        last = current
        return true
    }
}

private let ruleWatch = RuleWatch()

// MARK: - what the agent can see

/**
 * **The provider's only way to tell the agent anything** (#639).
 *
 * The agent runs on the host as the user and decides whether the network control is usable. Until
 * now it decided entirely from the *dylib's* verdict, which is evidence about layer 2 — so a filter
 * that was killed, never approved, or running an older bundle left the control saying "steerable"
 * over a kernel dropping nothing. There was no channel: the XPC mach service never registered, and
 * the container app exits before the provider has even been handed the new rule.
 *
 * A file is the channel, and **where it can go was measured rather than assumed.** `Host/main.swift`
 * asserted in a comment that the extension, running as root, cannot write `/tmp`. Nothing had tested
 * it. `resolvePath` tries the candidates in order and logs which one won, so the answer lives in the
 * first run's log rather than in someone's memory.
 *
 * It carries three things, because three issues wanted them and one file is cheaper than three
 * mechanisms: the rule this provider is actually holding (#639), what the per-flow attribution costs
 * (#641), and how often attribution *failed* rather than finding a host process (#642).
 */
private final class Heartbeat {
    private let lock = NSLock()
    private var path: String?
    private var probed = false
    private var lastWrite: CFAbsoluteTime = 0

    var flowsSimulator = 0
    var flowsHost = 0
    var flowsUnresolved = 0
    var flowsDropped = 0
    var walks = 0
    var walkNanos: UInt64 = 0

    /// Ordered by how likely the agent — a different uid — is to be able to read it back.
    private static let candidates = [
        "/Library/Application Support/tapflow",
        "/tmp",
        NSTemporaryDirectory(),
        NSHomeDirectory(),
    ]

    private func resolvePath() -> String? {
        if probed { return path }
        probed = true
        for dir in Heartbeat.candidates where !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                     attributes: [.posixPermissions: 0o755])
            let candidate = (dir as NSString).appendingPathComponent("tapflow-netfilter-state.json")
            if FileManager.default.createFile(atPath: candidate, contents: Data("{}\n".utf8),
                                              attributes: [.posixPermissions: 0o644]) {
                os_log("heartbeat path: %{public}@", log: log, type: .default, candidate)
                path = candidate
                return path
            }
            os_log("heartbeat path refused: %{public}@", log: log, type: .default, candidate)
        }
        os_log("no writable heartbeat path — the agent cannot see this provider", log: log, type: .error)
        return nil
    }

    /**
     * Write at most once a second, or immediately when the rule changed.
     *
     * The rate limit is what makes this affordable at all: `handleNewFlow` runs for every new
     * connection on the machine, and a file write there would be a syscall per flow on the host's
     * entire network. Freshness beyond a second buys nothing — the agent reads this when a tester
     * asks a question, not in a loop.
     */
    func write(rule: Set<String>, force: Bool) {
        lock.lock(); defer { lock.unlock() }
        let now = CFAbsoluteTimeGetCurrent()
        if !force && now - lastWrite < 1.0 { return }
        guard let path = resolvePath() else { return }
        lastWrite = now

        let avg = walks > 0 ? Double(walkNanos) / Double(walks) / 1000.0 : 0
        let rules = rule.sorted().map { "\"\($0)\"" }.joined(separator: ",")
        var json = "{\"at\":\(Int(Date().timeIntervalSince1970))"
        json += ",\"rule\":[\(rules)]"
        json += ",\"flows\":{\"simulator\":\(flowsSimulator),\"host\":\(flowsHost)"
        json += ",\"unresolved\":\(flowsUnresolved),\"dropped\":\(flowsDropped)}"
        json += ",\"attribution\":{\"walks\":\(walks),\"avgMicros\":\(String(format: "%.1f", avg))}}\n"
        try? Data(json.utf8).write(to: URL(fileURLWithPath: path), options: .atomic)
    }
}

private let heartbeat = Heartbeat()


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
        let rule = offlineUDIDs(filterConfiguration)
        let ruleChanged = ruleWatch.noteIfChanged(rule)

        // **How long the attribution actually takes** (#641). The walk was suspected of being an
        // unaffordable per-flow cost and nobody had measured it, so the answer is counted here and
        // reported rather than argued about. A cache added on a hunch is one more thing to keep
        // correct across pid reuse.
        let began = DispatchTime.now().uptimeNanoseconds
        let attribution: Attribution = pid > 0 ? attribute(pid) : .unresolved("no audit token")
        heartbeat.walks += 1
        heartbeat.walkNanos += DispatchTime.now().uptimeNanoseconds - began

        switch attribution {
        // A flow this Mac owns — the user's browser, mail, everything else. Allowed outright, which
        // also ENDS filtering for it, so nothing downstream is paid for by host traffic.
        case .host:
            heartbeat.flowsHost += 1
            os_log("handleNewFlow pid=%{public}d udid=- asid=%{public}u verdict=allow(host)",
                   log: log, type: .default, pid, asid)
            heartbeat.write(rule: rule, force: ruleChanged)
            return .allow()

        // **Not the same thing as a host flow, and it used to be logged as one** (#642). The walk
        // failed — no audit token, an unreadable `KERN_PROCARGS2`, a process that exited underneath
        // it — so this flow *might* belong to a simulator that is supposed to be offline.
        //
        // It is still allowed, and that is a decision rather than an oversight. Failing closed on a
        // failed `sysctl` would cut the user's own browser on a transient error, which is worse than
        // the hole: this filter is host-wide, and the whole promise of the feature is that only the
        // simulator you toggled is affected. What was actually wrong was that the hole was invisible
        // — indistinguishable in the log from an ordinary host flow, and absent from any counter.
        case .unresolved(let why):
            heartbeat.flowsUnresolved += 1
            os_log("handleNewFlow pid=%{public}d udid=? asid=%{public}u verdict=allow(UNRESOLVED: %{public}@)",
                   log: log, type: .error, pid, asid, why)
            heartbeat.write(rule: rule, force: ruleChanged)
            return .allow()

        case .simulator(let udid):
            heartbeat.flowsSimulator += 1
            let drop = rule.contains(udid)
            if drop { heartbeat.flowsDropped += 1 }
            os_log("handleNewFlow pid=%{public}d udid=%{public}@ asid=%{public}u verdict=%{public}@",
                   log: log, type: .default, pid, udid, asid, drop ? "DROP" : "allow")
            heartbeat.write(rule: rule, force: ruleChanged)
            return drop ? .drop() : .allow()
        }
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
/**
 * A process's parent and its **start time**, read together from one `sysctl`.
 *
 * The start time is what makes a pid an identity. macOS reuses pids, and `launchd_sim`'s is reused
 * readily — every simulator boot starts one, and a Mac that has booted a few dozen wraps the range.
 * A cache keyed on the number alone therefore answers for a simulator that no longer exists, and the
 * consequence is not a stale label: it is `handleNewFlow` cutting a device nobody asked to cut, with
 * every log line agreeing that the udid was right. `(pid, start)` is unique for the life of the Mac.
 *
 * Not `pidversion` from the audit token, which is there at word 7 and would be the obvious source:
 * it identifies the *flow's* process, and what has to be identified is its `launchd_sim` ancestor,
 * which has no token here.
 */
private struct ProcIdentity: Hashable {
    let pid: pid_t
    let startSec: Int64
    let startUsec: Int32
}

private func procSysctl(_ pid: pid_t) -> (ppid: pid_t, identity: ProcIdentity)? {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    var kp = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    guard sysctl(&mib, u_int(mib.count), &kp, &size, nil, 0) == 0, size > 0 else { return nil }
    let start = kp.kp_proc.p_un.__p_starttime
    return (kp.kp_eproc.e_ppid,
            ProcIdentity(pid: pid, startSec: Int64(start.tv_sec), startUsec: start.tv_usec))
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

// launchd_sim outlives every flow of the simulator it hosts, so caching by its identity holds for the
// whole boot and the per-flow cost stays at the parent walk. Only positive results are cached: a host
// flow is rejected by the launchd_sim path check before any argument read, so it never pays for the
// miss.
//
// **Keyed on the identity and not the pid**, for the reason on `ProcIdentity`. Entries are never
// evicted, which is affordable because the key is a boot rather than a process — one per simulator
// started while the provider has been running — and because it is *wrong* to evict on the same signal
// that inserts: a pid whose entry is dropped is looked up again and re-cached from `KERN_PROCARGS2`,
// which reads the CURRENT process's arguments. The stale answer would simply be re-derived. Keying it
// away is the only fix that does not depend on noticing the exit.
private final class UDIDCache {
    private var byRoot: [ProcIdentity: String] = [:]
    private let lock = NSLock()

    func lookup(_ root: ProcIdentity) -> String? {
        lock.lock(); defer { lock.unlock() }
        return byRoot[root]
    }

    func store(_ root: ProcIdentity, _ udid: String) {
        lock.lock(); defer { lock.unlock() }
        byRoot[root] = udid
    }
}

private let udidCache = UDIDCache()

/**
 * What a flow's process turned out to be — **three outcomes, where the code used to have two**.
 *
 * `udidForPID` returned `String?`, and `nil` meant both "this is the Mac's own traffic" and "the
 * walk failed". They were logged identically and counted not at all, so a simulator that should have
 * been offline could reach the network because a `sysctl` returned an error, with the log calling it
 * a host flow (#642).
 */
private enum Attribution {
    case simulator(String)
    case host
    case unresolved(String)
}

/// The parent walk, with its failures kept apart from its negative answer.
private func attribute(_ pid: pid_t) -> Attribution {
    var current = pid
    for _ in 0..<32 {
        guard let info = procSysctl(current) else {
            // The process is gone, or the kernel refused. Either way we do not know.
            return .unresolved("sysctl failed at pid \(current)")
        }
        if info.ppid <= 1 {
            if let path = pidPath(current), !path.hasSuffix("/launchd_sim") {
                return .host   // a known top-level process that is not a simulator's launchd
            }
            // An unreadable path falls through on purpose: the UDID pattern in the arguments is the
            // stronger check, and losing a flow to a path read would be the wrong trade.
            if let cached = udidCache.lookup(info.identity) { return .simulator(cached) }
            guard let udid = procArgs(current).flatMap(extractUDID) else {
                return .unresolved("no UDID in the arguments of pid \(current)")
            }
            udidCache.store(info.identity, udid)
            return .simulator(udid)
        }
        current = info.ppid
    }
    return .unresolved("parent chain did not terminate")
}
