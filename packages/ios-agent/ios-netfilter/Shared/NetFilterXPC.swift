import Foundation

// XPC contract between the container app (client) and the sysext provider (listener).
// handleAppMessage/sendProviderMessage do not route in a NETransparentProxyProvider (measured), so
// control + observation go over a mach service named by NEMachServiceName instead (SimpleFirewall pattern).
@objc public protocol NetFilterControl {
    // Observation: the flows the provider has seen since the last drain, as JSON {"flows":[...]}.
    func dumpFlows(withReply reply: @escaping (Data) -> Void)
    // Control: the set of pids whose non-loopback outbound flows must be dropped.
    func setOffline(_ pids: [Int], withReply reply: @escaping (Bool) -> Void)
}

public let netFilterMachServiceName = "6FBS3QP893.dev.tapflow.netfilter.ext"
