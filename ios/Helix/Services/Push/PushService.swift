import PushKit
import UIKit
import UserNotifications

/// Owns everything Apple push: the PushKit VoIP registration (incoming calls), the normal
/// notification permission/token, and the notification delegate. It only translates and
/// forwards; `HelixStore` decides what each event means. Created at launch by the app delegate
/// (not by a view) because a VoIP push can wake the app with no UI at all.
final class PushService: NSObject {
    static let shared = PushService()

    static let approvalCategory = "helix.approval"
    static let approveAction = "helix.approval.approve"
    static let rejectAction = "helix.approval.reject"

    private(set) var voipToken: String?
    private(set) var alertToken: String?

    /// A VoIP push arrived. The handler MUST report a CallKit call before running `completion`.
    var onIncomingCall: ((IncomingCallPush?, @escaping () -> Void) -> Void)?
    /// Either token was issued or changed: tell the gateway.
    var onTokensChanged: (() -> Void)?
    /// The user tapped a notification.
    var onAlertTapped: ((AlertPush) -> Void)?
    /// The user tapped Approve/Reject on an approval notification. Resolves when it was sent.
    var onApprovalAction: ((String, Bool) async -> Void)?

    private var registry: PKPushRegistry?

    func start() {
        guard registry == nil else { return }
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        self.registry = registry

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        // Approve opens the app so it can ask for Face ID/passcode (a background action cannot show
        // that prompt, and `.authenticationRequired` alone does not ask an unlocked phone for
        // anything). Reject is always safe, so it stays a one-tap background action.
        let approve = UNNotificationAction(identifier: Self.approveAction, title: "Approve", options: [.authenticationRequired, .foreground])
        let reject = UNNotificationAction(identifier: Self.rejectAction, title: "Reject", options: [.destructive])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.approvalCategory, actions: [approve, reject], intentIdentifiers: [])
        ])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error { print("PushService: notification permission failed: \(error)") }
            guard granted else { return }
            Task { @MainActor in UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func didRegisterForRemoteNotifications(deviceToken: Data) {
        alertToken = PushToken.hex(deviceToken)
        onTokensChanged?()
    }

    func didFailToRegisterForRemoteNotifications(_ error: Error) {
        print("PushService: remote notification registration failed: \(error)")
    }
}

extension PushService: PKPushRegistryDelegate {
    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        voipToken = PushToken.hex(pushCredentials.token)
        onTokensChanged?()
    }

    func pushRegistry(
        _ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType, completion: @escaping () -> Void
    ) {
        guard type == .voIP else { completion(); return }
        let push = IncomingCallPush(payload: payload.dictionaryPayload)
        guard let onIncomingCall else {
            // No store yet should be impossible (the app delegate builds it first), but the rule
            // is absolute: never return without reporting a call.
            print("PushService: VoIP push with no handler")
            completion()
            return
        }
        onIncomingCall(push, completion)
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .voIP else { return }
        voipToken = nil
    }
}

extension PushService: UNUserNotificationCenterDelegate {
    // Delegate callbacks arrive on arbitrary threads; this target defaults to MainActor, so they
    // are explicitly nonisolated. They use the completion-handler form on purpose: the `async`
    // variants resume on a background executor, and UIKit asserts (a hard crash when the user
    // taps a notification) if the completion is not called on the main thread. Confirmed from a
    // device crash report: `_performBlockAfterCATransactionCommitSynchronizes` assertion.

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void
    ) {
        // The gateway only pushes while the user is away, so one that arrives with the app open
        // is still worth showing.
        DispatchQueue.main.async { completionHandler([.banner, .sound, .list]) }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void
    ) {
        let action = response.actionIdentifier
        let alert = AlertPush(userInfo: response.notification.request.content.userInfo)
        Task { @MainActor in
            switch action {
            case Self.approveAction, Self.rejectAction:
                if let id = alert?.approvalID {
                    await self.onApprovalAction?(id, action == Self.approveAction)
                }
            case UNNotificationDefaultActionIdentifier:
                if let alert { self.onAlertTapped?(alert) }
            default:
                break
            }
            completionHandler()
        }
    }
}

/// Needed because SwiftUI's `App` has no hook for the remote-notification token callbacks, and
/// because a VoIP push can launch the app without ever creating a window.
final class HelixAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        _ = AppServices.store // builds the store (and wires its push handlers) before any push is delivered
        PushService.shared.start()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushService.shared.didRegisterForRemoteNotifications(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushService.shared.didFailToRegisterForRemoteNotifications(error)
    }
}

enum AppServices {
    /// One store for the whole process, reachable from the app delegate as well as the views.
    static let store: HelixStore = {
        let store = HelixStore()
        store.connectPush()
        return store
    }()
}
