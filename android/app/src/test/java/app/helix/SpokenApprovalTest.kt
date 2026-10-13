package app.helix

import app.helix.call.SpokenApproval
import app.helix.call.SpokenApproval.Decision
import app.helix.call.SpokenApproval.Outcome
import app.helix.call.SpokenApproval.Phase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** The same cases as the iPhone's SpokenApprovalTests: keyword matching, never a model, and confirmation before sending. */
class SpokenApprovalTest {
    @Test fun clearWordsAreRecognised() {
        assertEquals(Decision.Approve, SpokenApproval.decision("Approve"))
        assertEquals(Decision.Approve, SpokenApproval.decision("yes go ahead"))
        assertEquals(Decision.Reject, SpokenApproval.decision("Reject it."))
        assertEquals(Decision.Reject, SpokenApproval.decision("no, stop"))
    }

    @Test fun ambiguityNeverDecides() {
        assertEquals(Decision.Unclear, SpokenApproval.decision("yes no wait"))
        assertEquals(Decision.Unclear, SpokenApproval.decision("don't approve"))
        assertEquals(Decision.Unclear, SpokenApproval.decision("don’t approve"))
        assertEquals(Decision.Unclear, SpokenApproval.decision("I know"))
        assertEquals(Decision.Unclear, SpokenApproval.decision(""))
    }

    @Test fun nothingIsSentWithoutConfirmation() {
        val flow = SpokenApproval()
        assertEquals(Outcome.Say("I heard approve. Say confirm to allow it, or cancel to go back."), flow.hear("approve"))
        assertEquals(Phase.AwaitingConfirmation(true), flow.phase)
        assertNotNull(flow.hear("hmm maybe"))
        assertEquals(Phase.AwaitingConfirmation(true), flow.phase)
        assertEquals(Outcome.Send(true), flow.hear("confirm"))
        assertNull(flow.hear("approve"))
    }

    @Test fun cancelGoesBackAndRejectConfirms() {
        val flow = SpokenApproval()
        flow.hear("approve")
        flow.hear("cancel")
        assertEquals(Phase.AwaitingDecision, flow.phase)
        flow.hear("reject")
        assertEquals(Outcome.Send(false), flow.hear("yes confirm"))
    }
}
