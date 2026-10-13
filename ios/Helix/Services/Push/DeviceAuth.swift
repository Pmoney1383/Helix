import LocalAuthentication

/// Face ID / Touch ID, falling back to the device passcode. `UNNotificationActionOptions.
/// authenticationRequired` only means "the phone must be unlocked", so an already-unlocked phone
/// approves with no prompt at all; approving something from a banner needs a real check.
enum DeviceAuth {
    static func confirm(reason: String) async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            // No passcode set at all: nothing to ask for, and refusing would make Approve unusable.
            return true
        }
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        } catch {
            return false
        }
    }
}
