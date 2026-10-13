package app.helix.call

/**
 * Interprets what the user says on an approval call. Deliberately keyword matching, never a language model
 * (docs/CALLS.md section 3): anything an agent writes could try to talk its way into an approval, but a match on the user's
 * own voice cannot be prompt-injected. The same rules and words as the iPhone's SpokenApproval.swift.
 *
 * Flow: listen for a decision, repeat it back, require an explicit confirmation, only then report [Outcome.Send].
 */
class SpokenApproval {
    sealed interface Phase {
        data object AwaitingDecision : Phase
        data class AwaitingConfirmation(val approve: Boolean) : Phase
        data object Finished : Phase
    }

    sealed interface Outcome {
        /** Say this and keep listening. */
        data class Say(val text: String) : Outcome
        /** Confirmed: send this decision to the gateway. */
        data class Send(val approve: Boolean) : Outcome
    }

    enum class Decision { Approve, Reject, Unclear }

    var phase: Phase = Phase.AwaitingDecision
        private set

    fun hear(utterance: String): Outcome? = when (val p = phase) {
        Phase.AwaitingDecision -> when (decision(utterance)) {
            Decision.Approve -> { phase = Phase.AwaitingConfirmation(true); Outcome.Say("I heard approve. Say confirm to allow it, or cancel to go back.") }
            Decision.Reject -> { phase = Phase.AwaitingConfirmation(false); Outcome.Say("I heard reject. Say confirm to reject it, or cancel to go back.") }
            Decision.Unclear -> Outcome.Say("Sorry, I did not catch that. Say approve to allow it, or reject to stop it.")
        }
        is Phase.AwaitingConfirmation -> when (isConfirmation(utterance)) {
            true -> { phase = Phase.Finished; Outcome.Send(p.approve) }
            false -> { phase = Phase.AwaitingDecision; Outcome.Say("Okay. Say approve to allow it, or reject to stop it.") }
            null -> Outcome.Say(if (p.approve) "Say confirm to approve it, or cancel to go back." else "Say confirm to reject it, or cancel to go back.")
        }
        Phase.Finished -> null
    }

    companion object {
        private val approveWords = setOf("approve", "approved", "yes", "yeah", "yep", "allow", "accept")
        private val approvePhrases = listOf("do it", "go ahead", "go for it", "run it")
        private val rejectWords = setOf("reject", "rejected", "no", "nope", "stop", "cancel", "deny", "denied", "decline", "refuse")
        private val rejectPhrases = listOf("do not", "don't do", "dont do")
        private val confirmWords = setOf("confirm", "confirmed", "yes", "yeah", "yep", "correct", "right", "sure")
        private val confirmPhrases = listOf("that's right", "thats right", "go ahead", "do it")
        private val backOutWords = setOf("no", "nope", "wrong", "cancel", "wait", "incorrect", "back")

        fun decision(utterance: String): Decision {
            val (words, text) = normalize(utterance)
            val hasApprove = words.any { it in approveWords } || approvePhrases.any { text.contains(it) }
            val hasReject = words.any { it in rejectWords } || rejectPhrases.any { text.contains(it) }
            val negated = "not" in words || "don't" in words || "dont" in words || "never" in words
            // "yes do it but no wait" and the like: both kinds of word means we cannot tell.
            if (hasApprove == hasReject) return Decision.Unclear
            if (negated) return Decision.Unclear
            return if (hasApprove) Decision.Approve else Decision.Reject
        }

        private fun isConfirmation(utterance: String): Boolean? {
            val (words, text) = normalize(utterance)
            val yes = words.any { it in confirmWords } || confirmPhrases.any { text.contains(it) }
            val no = words.any { it in backOutWords }
            if (yes == no) return null
            if ("not" in words || "don't" in words || "dont" in words) return null
            return yes
        }

        private fun normalize(utterance: String): Pair<Set<String>, String> {
            val lowered = utterance.lowercase().replace('’', '\'')
            val cleaned = lowered.map { if (it.isLetter() || it == '\'') it else ' ' }.joinToString("")
            val text = cleaned.split(' ').filter { it.isNotEmpty() }.joinToString(" ")
            return text.split(' ').filter { it.isNotEmpty() }.toSet() to text
        }
    }
}
