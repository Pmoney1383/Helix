import Intents
import OSLog

// Siri resolves the call here, then continues into Helix (`.continueInApp`), which starts the
// real CallKit call. INIntentsSupported lives on this extension only: declaring it on the app
// too routes Siri to in-app handling the app does not implement (found while prototyping).
final class IntentHandler: INExtension, INStartCallIntentHandling {
    private let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "helix", category: "SiriIntent")

    override func handler(for intent: INIntent) -> Any? {
        intent is INStartCallIntent ? self : nil
    }

    func resolveContacts(
        for intent: INStartCallIntent, with completion: @escaping ([INStartCallContactResolutionResult]) -> Void
    ) {
        guard let person = intent.contacts?.first else {
            completion([.needsValue()])
            return
        }
        completion([.success(with: person)])
    }

    func confirm(intent: INStartCallIntent, completion: @escaping (INStartCallIntentResponse) -> Void) {
        completion(INStartCallIntentResponse(code: .ready, userActivity: nil))
    }

    func handle(intent: INStartCallIntent, completion: @escaping (INStartCallIntentResponse) -> Void) {
        logger.notice("continuing call in the app")
        completion(INStartCallIntentResponse(code: .continueInApp, userActivity: NSUserActivity(activityType: "INStartCallIntent")))
    }
}
