import Foundation

/// Identity and pending text for one recognition task. Retiring a task invalidates its
/// callbacks immediately, before Speech finishes delivering cancellation/final results.
struct RecognitionTurnState {
    private(set) var generation = 0
    private(set) var active = false
    private(set) var text = ""

    mutating func begin() -> Int {
        generation += 1
        active = true
        text = ""
        return generation
    }

    func accepts(_ generation: Int) -> Bool {
        active && self.generation == generation
    }

    mutating func update(_ text: String, for generation: Int) {
        guard accepts(generation) else { return }
        self.text = text
    }

    /// Returns the pending utterance once, including a final result received before the
    /// silence timer. The updated generation can also guard a delayed restart.
    mutating func retire() -> String {
        let pending = text.trimmingCharacters(in: .whitespacesAndNewlines)
        generation += 1
        active = false
        text = ""
        return pending
    }

    func canRestart(after generation: Int) -> Bool {
        !active && self.generation == generation
    }
}
