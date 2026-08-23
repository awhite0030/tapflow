import Foundation
import NetworkExtension

// XPC listener + shared state, standing apart from the Provider instance — the SimpleFirewall/rama
// pattern. The listener is started from main.swift right after startSystemExtensionMode (NOT from
// startProxy), so the mach service is vended as soon as the sysext runs, independent of proxy state.
// Provider.handleNewFlow records flows here and reads the offline set here.
final class IPCConnection: NSObject, NSXPCListenerDelegate, NetFilterControl {
    static let shared = IPCConnection()

    private let q = DispatchQueue(label: "dev.tapflow.netfilter.state")
    private var recentFlows: [[String: Any]] = []   // observation buffer, drained by dumpFlows
    private var offlinePids: Set<Int32> = []          // control set, injected by setOffline
    private var listener: NSXPCListener?

    func startListener() {
        let l = NSXPCListener(machServiceName: netFilterMachServiceName)
        l.delegate = self
        l.resume()
        listener = l
    }

    // Called from Provider.handleNewFlow.
    func record(pid: Int32, dst: String, loopback: Bool, dropped: Bool) {
        q.async {
            self.recentFlows.append(["pid": Int(pid), "dst": dst, "loopback": loopback, "dropped": dropped])
            let overflow = self.recentFlows.count - 500
            if overflow > 0 { self.recentFlows.removeFirst(overflow) }
        }
    }

    func isOffline(_ pid: Int32) -> Bool { q.sync { offlinePids.contains(pid) } }

    // MARK: NSXPCListenerDelegate
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection conn: NSXPCConnection) -> Bool {
        conn.exportedInterface = NSXPCInterface(with: NetFilterControl.self)
        conn.exportedObject = self
        conn.resume()
        return true
    }

    // MARK: NetFilterControl (called by the container app over XPC)
    func dumpFlows(withReply reply: @escaping (Data) -> Void) {
        q.async {
            let flows = self.recentFlows
            self.recentFlows.removeAll(keepingCapacity: true)
            reply((try? JSONSerialization.data(withJSONObject: ["flows": flows])) ?? Data())
        }
    }

    func setOffline(_ pids: [Int], withReply reply: @escaping (Bool) -> Void) {
        q.async {
            self.offlinePids = Set(pids.map { Int32($0) })
            reply(true)
        }
    }
}
