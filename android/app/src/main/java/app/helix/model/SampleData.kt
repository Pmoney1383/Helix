package app.helix.model

import app.helix.ui.theme.Symbol
import java.time.Instant

/** Stand-in content until the app talks to the gateway (the same as the iPhone's SampleData). Times are relative to launch. */
object SampleData {
    private fun ago(hours: Double = 0.0, minutes: Double = 0.0): Instant =
        Instant.now().minusMillis(((hours * 3_600 + minutes * 60) * 1000).toLong())

    private fun fromNow(minutes: Double): Instant = Instant.now().plusMillis((minutes * 60_000).toLong())

    val gateway get() = GatewayStatus(isOnline = true, hostName = "my-pc", address = "my-pc.my-tailnet.ts.net", lastHeartbeat = ago(minutes = 0.1))

    val pc = PCStatus(cpu = 0.34, gpu = 0.97, memory = 0.62, gpuName = "RTX 4090")

    val hero get() = HeroUpdate(
        eyebrow = "AI Update",
        title = "Training is still running.",
        detail = "Claude is processing new data and improving tool use.",
        etaLabel = "Estimated completion",
        estimatedCompletion = fromNow(84.0),
        conversationID = "training",
    )

    val conversations: List<Conversation> get() = listOf(
        Conversation(
            id = "training", title = "Claude Training Session", typeLabel = "Training run", icon = TileIcon.Monogram("AI"),
            provider = Provider.Claude, lastActivityAt = ago(2.0, 14.0),
            messages = listOf(
                ChatMessage("t1", MessageSender.User, "Kick off the next fine-tune on the new tool-use set and keep an eye on it.", ago(5.0)),
                ChatMessage("t2", MessageSender.Agent, "Started. 120,000 steps on the RTX 4090, checkpoints every 4,000. I set a watcher on the log, so I'll message you if it finishes and call if it crashes.", ago(4.0, 58.0)),
                ChatMessage("t3", MessageSender.User, "[Helix watcher] Checkpoint saved at step 84,000.", ago(2.0, 20.0)),
                ChatMessage("t4", MessageSender.Agent, "Still healthy. Step 84,231, loss 0.184, GPU at 97%. About an hour and a half to go.", ago(2.0, 14.0)),
            ),
        ),
        Conversation(
            id = "planning", title = "Project Planning", typeLabel = "Chat session", icon = TileIcon.Sym(Symbol.Chat),
            provider = Provider.Claude, lastActivityAt = ago(6.0),
            messages = listOf(
                ChatMessage("p1", MessageSender.User, "What's left before the Helix app can take real calls?", ago(6.0, 5.0)),
                ChatMessage("p2", MessageSender.Agent, "Outgoing calls work today. Incoming calls wait on the Apple Developer membership: PushKit needs the paid entitlement and the APNs key on the PC.", ago(6.0)),
            ),
        ),
        Conversation(
            id = "general-claude", title = "General Claude", typeLabel = "Front door", icon = TileIcon.Brand(Logo.Claude),
            provider = Provider.Claude, frontDoor = FrontDoor.Claude, lastActivityAt = ago(20.0),
            messages = listOf(
                ChatMessage("g1", MessageSender.User, "How is the cat diffusion training doing?", ago(20.0, 2.0)),
                ChatMessage("g2", MessageSender.System, "Handed to Cat Diffusion", ago(20.0, 1.0)),
                ChatMessage("g3", MessageSender.Agent, "Step 84,231. Loss is 0.184 and the GPU is at 97%. Nothing looks wrong.", ago(20.0)),
            ),
        ),
        Conversation(
            id = "astra", title = "Astra", typeLabel = "Front door", icon = TileIcon.Brand(Logo.OpenAI),
            provider = Provider.Codex, frontDoor = FrontDoor.Codex, lastActivityAt = ago(30.0),
            messages = listOf(
                ChatMessage("c1", MessageSender.User, "Open the Orbit session and check the networking bug.", ago(30.0, 1.0)),
                ChatMessage("c2", MessageSender.Agent, "Resumed Orbit. The reconnect loop never backs off after a timeout; I've drafted a fix with exponential backoff.", ago(30.0)),
            ),
        ),
        Conversation(
            id = "orbit", title = "Orbit", typeLabel = "Codex session", icon = TileIcon.Sym(Symbol.Code),
            provider = Provider.Codex, lastActivityAt = ago(29.0),
            messages = listOf(ChatMessage("r1", MessageSender.Agent, "Backoff fix is in. Tests pass locally; want me to push the branch?", ago(29.0))),
        ),
        Conversation(
            id = "recipes", title = "Recipe Box", typeLabel = "Chat session", icon = TileIcon.Sym(Symbol.ForkKnife),
            provider = Provider.Claude, lastActivityAt = ago(75.0),
            messages = listOf(ChatMessage("w1", MessageSender.Agent, "Recipe import now handles fractions like ½ cup.", ago(75.0))),
        ),
    )

    val sessions: List<AgentSession> get() = listOf(
        AgentSession("claude:training", Provider.Claude, "Claude Training Session", "helix-train", ago(minutes = 1.0), true, LiveStatus.Busy, true),
        AgentSession("claude:cat", Provider.Claude, "Cat Diffusion", "cat-diffusion", ago(minutes = 12.0), true, LiveStatus.Idle, false),
        AgentSession("codex:orbit", Provider.Codex, "Orbit", "orbit", ago(29.0), false, null, true),
    )

    val watchers: List<Watcher> get() = listOf(
        Watcher("w-train", "Training run", "Healthy • step 84,231", Severity.Info, ago(minutes = 3.0)),
        Watcher("w-disk", "Disk C:", "62% used", Severity.Info, ago(minutes = 10.0)),
        Watcher("w-deploy", "Orbit deploy", "Last run failed", Severity.Important, ago(26.0)),
    )

    val approvals: List<Approval> get() = listOf(
        Approval("a1", "Claude Training Session", "Bash", "Delete checkpoints/old-run-17 (14.2 GB)",
            listOf("Recursive delete", "Frees space for the next checkpoint"), ApprovalStatus.Pending, ago(minutes = 4.0), fromNow(26.0)),
        Approval("a2", "Orbit", "git clean", "Remove 38 untracked files in orbit/",
            listOf("Git can't restore untracked files"), ApprovalStatus.Pending, ago(minutes = 12.0), fromNow(18.0)),
        Approval("a3", "Cat Diffusion", "sqlite", "Drop table scratch_metrics", listOf("Database DROP"), ApprovalStatus.Approved,
            ago(22.0), ago(21.0, 30.0), ago(21.0, 58.0)),
    )

    val calls: List<Call> get() = listOf(
        Call("k1", CallDirection.Outgoing, CallStatus.Ended, Severity.Info, "Call Claude", "Checked on the training run", Provider.Claude, ago(2.0, 30.0), 252.0),
        Call("k2", CallDirection.Incoming, CallStatus.Ended, Severity.Critical, "Claude", "Training stopped: disk full", Provider.Claude, ago(22.0), 95.0),
        Call("k3", CallDirection.Incoming, CallStatus.Missed, Severity.Important, "Astra", "Orbit deploy failed", Provider.Codex, ago(26.0)),
        Call("k4", CallDirection.Outgoing, CallStatus.Ended, Severity.Info, "Call Astra", "Orbit networking bug", Provider.Codex, ago(72.0), 431.0),
    )

    val persona = PersonaSettings(
        enabled = true, mode = PersonaMode.Professional, teasing = 0.0, flirtiness = 0.0, sarcasm = 0.0, verbosity = 0.2,
        speechRate = 0.5, usePCVoice = false, petNames = listOf("babe", "handsome", "trouble"),
    )
}
