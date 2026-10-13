import Testing
@testable import Helix

struct RecognitionTurnStateTests {
    @Test func lateFinalFromFirstUtteranceCannotEndOrOverwriteSecond() {
        var state = RecognitionTurnState()
        let first = state.begin()
        state.update("first message", for: first)
        #expect(state.retire() == "first message")
        let second = state.begin()
        state.update("second message", for: second)

        // Speech may deliver A's final result/error after B has already started.
        #expect(!state.accepts(first))
        state.update("late first message", for: first)
        #expect(state.accepts(second))
        #expect(state.retire() == "second message")
    }

    @Test func finalResultBeforeSilenceTimerIsDeliveredOnce() {
        var state = RecognitionTurnState()
        let task = state.begin()
        state.update("partial", for: task)
        state.update("complete final transcript", for: task)
        #expect(state.retire() == "complete final transcript")
        // A queued silence timer/final callback must no longer be accepted.
        #expect(!state.accepts(task))
        #expect(state.retire().isEmpty)
    }

    @Test func delayedRetryCannotReplaceNewTask() {
        var state = RecognitionTurnState()
        _ = state.begin()
        _ = state.retire()
        let retry = state.generation
        #expect(state.canRestart(after: retry))
        let next = state.begin()
        #expect(!state.canRestart(after: retry))
        #expect(state.accepts(next))
    }

    @Test func stoppedCallInvalidatesCallbacksAndRetriesEvenAfterNextCallStarts() {
        var state = RecognitionTurnState()
        let oldCallTask = state.begin()
        _ = state.retire()
        let retry = state.generation
        // stop() retires again, even when waiting for a retry rather than listening.
        _ = state.retire()
        #expect(!state.canRestart(after: retry))
        let newCallTask = state.begin()
        #expect(!state.accepts(oldCallTask))
        #expect(!state.canRestart(after: retry))
        #expect(state.accepts(newCallTask))
    }

    @Test func repeatedUtterancesRemainIndependent() {
        var state = RecognitionTurnState()
        var oldTasks: [Int] = []
        for message in ["hello Claude", "what is running", "tell me more"] {
            let task = state.begin()
            for old in oldTasks {
                #expect(!state.accepts(old))
                state.update("stale callback", for: old)
            }
            state.update(message, for: task)
            #expect(state.retire() == message)
            oldTasks.append(task)
        }
    }

    @Test func emptyTaskDoesNotProduceAnUtterance() {
        var state = RecognitionTurnState()
        let task = state.begin()
        state.update(" \n ", for: task)
        #expect(state.retire().isEmpty)
    }
}
