import Foundation
import NetworkExtension
import os.log

/**
 * The box the listener answers from — **the running provider, held weakly, read on demand.**
 *
 * Weak and boxed rather than captured: the listener is vended once for the life of the process and a
 * filter can be stopped and started again inside it, so a listener holding a `Provider` would answer
 * for one that has been replaced. `startFilter` fills this after `apply` succeeds and `stopFilter`
 * empties it, which makes "is anything enforcing" a property of the box rather than a flag anyone has
 * to remember to clear.
 *
 * **The configuration is read at answer time, never cached.** A snapshot taken when the box was
 * filled would be up to one pulse old, and reporting a stale rule as the current one is the failure
 * this channel was added to remove.
 */
final class ProviderBox {
    static let shared = ProviderBox()

    private let lock = NSLock()
    private weak var provider: NEFilterDataProvider?

    func set(_ p: NEFilterDataProvider?) {
        lock.lock(); provider = p; lock.unlock()
    }

    /// `enforcing` is "the box is not empty". Nothing else can say it: a stopped provider is still a
    /// live process answering XPC, and its rule is empty for the same reason an idle one's is.
    func snapshot() -> (enforcing: Bool, rule: [String]) {
        lock.lock(); let p = provider; lock.unlock()
        guard let p else { return (false, []) }
        return (true, offlineUDIDs(p.filterConfiguration).sorted())
    }
}

/// Vends the mach service and answers `ping`. Started once from `main.swift`, so the service exists
/// for as long as the process does — independent of whether a filter is currently running, which is
/// exactly the question callers need answered.
final class IPCListener: NSObject, NSXPCListenerDelegate, NetFilterControl {
    static let shared = IPCListener()

    private let log = OSLog(subsystem: "dev.tapflow.netfilter", category: "xpc")
    private let listener = NSXPCListener(machServiceName: netFilterMachServiceName)

    override private init() {
        super.init()
        listener.delegate = self
    }

    func start() {
        listener.resume()
        os_log("xpc listener resumed on %{public}@", log: log, type: .default, netFilterMachServiceName)
    }

    // MARK: - NSXPCListenerDelegate

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection conn: NSXPCConnection) -> Bool {
        // **The peer is not authenticated, and the interface is read-only because of it** — see
        // `NetFilterControl`. Pinning the connection's audit token to this team's signature is its own
        // change; until it lands, the exposure this accepts is a read of which simulators are offline.
        os_log("xpc connection from pid %{public}d", log: log, type: .info, conn.processIdentifier)
        conn.exportedInterface = NSXPCInterface(with: NetFilterControl.self)
        conn.exportedObject = self
        conn.resume()
        return true
    }

    // MARK: - NetFilterControl

    func ping(withReply reply: @escaping (Data) -> Void) {
        let (enforcing, rule) = ProviderBox.shared.snapshot()
        let body: [String: Any] = [
            "enforcing": enforcing,
            "rule": rule,
            "pid": ProcessInfo.processInfo.processIdentifier,
        ]
        reply((try? JSONSerialization.data(withJSONObject: body)) ?? Data("{}".utf8))
    }
}
