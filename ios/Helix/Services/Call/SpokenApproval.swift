import Foundation

/// Interprets what the user says on an approval call. Deliberately keyword matching, never a
/// language model (docs/CALLS.md section 3): anything an agent writes could try to talk its way
/// into an approval, but a match on the user's own voice cannot be prompt-injected.
///
/// Flow: listen for a decision, repeat it back, require an explicit confirmation, only then
/// report `.send`. Anything unclear asks again; nothing destructive is ever sent on a guess.
struct SpokenApproval {
    enum Phase: Equatable {
        case awaitingDecision
        case awaitingConfirmation(approve: Bool)
        case finished
    }

    enum Outcome: Equatable {
        /// Say this and keep listening.
        case say(String)
        /// Confirmed: send this decision to the gateway.
        case send(approve: Bool)
    }

    private(set) var phase: Phase = .awaitingDecision

    private static let approveWords: Set<String> = ["approve", "approved", "yes", "yeah", "yep", "allow", "accept"]
    private static let approvePhrases = ["do it", "go ahead", "go for it", "run it"]
    private static let rejectWords: Set<String> = ["reject", "rejected", "no", "nope", "stop", "cancel", "deny", "denied", "decline", "refuse"]
    private static let rejectPhrases = ["do not", "don't do", "dont do"]
    private static let confirmWords: Set<String> = ["confirm", "confirmed", "yes", "yeah", "yep", "correct", "right", "sure"]
    private static let confirmPhrases = ["that's right", "thats right", "go ahead", "do it"]
    private static let backOutWords: Set<String> = ["no", "nope", "wrong", "cancel", "wait", "incorrect", "back"]

    enum Decision: Equatable { case approve, reject, unclear }

    static func decision(from utterance: String) -> Decision {
        let (words, text) = normalize(utterance)
        let hasApprove = !words.isDisjoint(with: approveWords) || approvePhrases.contains { text.contains($0) }
        let hasReject = !words.isDisjoint(with: rejectWords) || rejectPhrases.contains { text.contains($0) }
        let negated = words.contains("not") || words.contains("don't") || words.contains("dont") || words.contains("never")
        // "yes do it but no wait" and the like: both kinds of word means we cannot tell.
        if hasApprove == hasReject { return .unclear }
        if negated { return .unclear }
        return hasApprove ? .approve : .reject
    }

    private static func isConfirmation(_ utterance: String) -> Bool? {
        let (words, text) = normalize(utterance)
        let yes = !words.isDisjoint(with: confirmWords) || confirmPhrases.contains { text.contains($0) }
        let no = !words.isDisjoint(with: backOutWords)
        if yes == no { return nil }
        if words.contains("not") || words.contains("don't") || words.contains("dont") { return nil }
        return yes
    }

    private static func normalize(_ utterance: String) -> (Set<String>, String) {
        let lowered = utterance.lowercased().replacingOccurrences(of: "\u{2019}", with: "'")
        let cleaned = lowered.unicodeScalars.map { CharacterSet.letters.contains($0) || $0 == "'" ? Character($0) : " " }
        let text = String(cleaned).split(separator: " ").joined(separator: " ")
        return (Set(text.split(separator: " ").map(String.init)), text)
    }

    mutating func hear(_ utterance: String) -> Outcome? {
        switch phase {
        case .awaitingDecision:
            switch Self.decision(from: utterance) {
            case .approve:
                phase = .awaitingConfirmation(approve: true)
                return .say("I heard approve. Say confirm to allow it, or cancel to go back.")
            case .reject:
                phase = .awaitingConfirmation(approve: false)
                return .say("I heard reject. Say confirm to reject it, or cancel to go back.")
            case .unclear:
                return .say("Sorry, I did not catch that. Say approve to allow it, or reject to stop it.")
            }
        case .awaitingConfirmation(let approve):
            switch Self.isConfirmation(utterance) {
            case true?:
                phase = .finished
                return .send(approve: approve)
            case false?:
                phase = .awaitingDecision
                return .say("Okay. Say approve to allow it, or reject to stop it.")
            case nil:
                return .say(approve
                    ? "Say confirm to approve it, or cancel to go back."
                    : "Say confirm to reject it, or cancel to go back.")
            }
        case .finished:
            return nil
        }
    }
}
