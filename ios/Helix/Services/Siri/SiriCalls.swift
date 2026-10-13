import SwiftUI
import Intents
import IntentsUI
import OSLog

/// Siri "call Claude" / "call Astra": the HelixIntents extension resolves the request and
/// continues in the app, which lands in `HelixStore.startCall` (-> CallKit -> the voice loop).
enum SiriCalls {
    private static let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "helix", category: "Siri")

    /// The front door a Siri request names. Anything unrecognised means Claude.
    static func door(for intent: INStartCallIntent) -> FrontDoor {
        let person = intent.contacts?.first
        let name = (person?.displayName ?? person?.personHandle?.value ?? "").lowercased()
        return name.contains("astra") || name.contains("codex") ? .codex : .claude
    }

    static func makeIntent(for door: FrontDoor) -> INStartCallIntent {
        let name = door.displayName
        let person = INPerson(personHandle: INPersonHandle(value: name, type: .unknown),
                              nameComponents: nil, displayName: name, image: nil,
                              contactIdentifier: nil, customIdentifier: door.rawValue)
        return INStartCallIntent(callRecordFilter: nil, callRecordToCallBack: nil, audioRoute: .unknown,
                                 destinationType: .normal, contacts: [person], callCapability: .audioCall)
    }

    /// Lets Siri learn "Claude" and "Astra" as call targets.
    static func donate() {
        for door in FrontDoor.allCases {
            INInteraction(intent: makeIntent(for: door), response: nil).donate { error in
                if let error { log.error("donate \(door.rawValue, privacy: .public) failed: \(error.localizedDescription, privacy: .public)") }
            }
        }
    }
}

/// Apple's "Add to Siri" button: records an exact phrase bound to the call intent.
struct AddToSiriButton: UIViewRepresentable {
    let door: FrontDoor

    func makeUIView(context: Context) -> INUIAddVoiceShortcutButton {
        let button = INUIAddVoiceShortcutButton(style: .whiteOutline)
        button.shortcut = INShortcut(intent: SiriCalls.makeIntent(for: door))
        button.delegate = context.coordinator
        return button
    }

    func updateUIView(_ uiView: INUIAddVoiceShortcutButton, context: Context) {
        uiView.shortcut = INShortcut(intent: SiriCalls.makeIntent(for: door))
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, INUIAddVoiceShortcutButtonDelegate,
                              INUIAddVoiceShortcutViewControllerDelegate,
                              INUIEditVoiceShortcutViewControllerDelegate {
        func present(_ controller: INUIAddVoiceShortcutViewController, for button: INUIAddVoiceShortcutButton) {
            controller.delegate = self
            Self.top()?.present(controller, animated: true)
        }

        func present(_ controller: INUIEditVoiceShortcutViewController, for button: INUIAddVoiceShortcutButton) {
            controller.delegate = self
            Self.top()?.present(controller, animated: true)
        }

        func addVoiceShortcutViewController(_ controller: INUIAddVoiceShortcutViewController, didFinishWith voiceShortcut: INVoiceShortcut?, error: Error?) {
            controller.dismiss(animated: true)
        }
        func addVoiceShortcutViewControllerDidCancel(_ controller: INUIAddVoiceShortcutViewController) {
            controller.dismiss(animated: true)
        }
        func editVoiceShortcutViewController(_ controller: INUIEditVoiceShortcutViewController, didUpdate voiceShortcut: INVoiceShortcut?, error: Error?) {
            controller.dismiss(animated: true)
        }
        func editVoiceShortcutViewController(_ controller: INUIEditVoiceShortcutViewController, didDeleteVoiceShortcutWithIdentifier deletedVoiceShortcutIdentifier: UUID) {
            controller.dismiss(animated: true)
        }
        func editVoiceShortcutViewControllerDidCancel(_ controller: INUIEditVoiceShortcutViewController) {
            controller.dismiss(animated: true)
        }

        private static func top() -> UIViewController? {
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            var vc = scene?.keyWindow?.rootViewController
            while let presented = vc?.presentedViewController { vc = presented }
            return vc
        }
    }
}
