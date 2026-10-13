import Foundation

/// Stand-in content until the app talks to the gateway. Times are relative to launch.
enum SampleData {
    private static func ago(hours: Double = 0, minutes: Double = 0) -> Date {
        Date.now.addingTimeInterval(-(hours * 3_600 + minutes * 60))
    }

    private static func fromNow(minutes: Double) -> Date {
        Date.now.addingTimeInterval(minutes * 60)
    }

    static let gateway = GatewayStatus(
        isOnline: true,
        hostName: "my-pc",
        address: "my-pc.my-tailnet.ts.net",
        lastHeartbeat: ago(minutes: 0.1)
    )

    static let pc = PCStatus(cpu: 0.34, gpu: 0.97, memory: 0.62, gpuName: "RTX 4090")

    static let hero = HeroUpdate(
        eyebrow: "AI Update",
        title: "Training is still running.",
        detail: "Claude is processing new data and improving tool use.",
        etaLabel: "Estimated completion",
        estimatedCompletion: fromNow(minutes: 84),
        conversationID: "training"
    )

    static let conversations: [Conversation] = [
        Conversation(
            id: "training",
            title: "Claude Training Session",
            typeLabel: "Training run",
            icon: .monogram("AI"),
            provider: .claude,
            lastActivityAt: ago(hours: 2, minutes: 14),
            messages: [
                ChatMessage(id: "t1", sender: .user, text: "Kick off the next fine-tune on the new tool-use set and keep an eye on it.", createdAt: ago(hours: 5)),
                ChatMessage(id: "t2", sender: .agent, text: "Started. 120,000 steps on the RTX 4090, checkpoints every 4,000. I set a watcher on the log, so I'll message you if it finishes and call if it crashes.", createdAt: ago(hours: 4, minutes: 58)),
                ChatMessage(id: "t3", sender: .user, text: "[Helix watcher] Checkpoint saved at step 84,000.", createdAt: ago(hours: 2, minutes: 20)),
                ChatMessage(id: "t4", sender: .agent, text: "Still healthy. Step 84,231, loss 0.184, GPU at 97%. About an hour and a half to go.", createdAt: ago(hours: 2, minutes: 14)),
            ]
        ),
        Conversation(
            id: "planning",
            title: "Project Planning",
            typeLabel: "Chat session",
            icon: .symbol("bubble.left"),
            provider: .claude,
            lastActivityAt: ago(hours: 6),
            messages: [
                ChatMessage(id: "p1", sender: .user, text: "What's left before the Helix app can take real calls?", createdAt: ago(hours: 6, minutes: 5)),
                ChatMessage(id: "p2", sender: .agent, text: "Outgoing calls work today. Incoming calls wait on the Apple Developer membership: PushKit needs the paid entitlement and the APNs key on the PC.", createdAt: ago(hours: 6)),
            ]
        ),
        Conversation(
            id: "general-claude",
            title: "General Claude",
            typeLabel: "Front door",
            icon: .logo(FrontDoor.claude.logo),
            provider: .claude,
            frontDoor: .claude,
            lastActivityAt: ago(hours: 20),
            messages: [
                ChatMessage(id: "g1", sender: .user, text: "How is the cat diffusion training doing?", createdAt: ago(hours: 20, minutes: 2)),
                ChatMessage(id: "g2", sender: .system, text: "Handed to Cat Diffusion", createdAt: ago(hours: 20, minutes: 1)),
                ChatMessage(id: "g3", sender: .agent, text: "Step 84,231. Loss is 0.184 and the GPU is at 97%. Nothing looks wrong.", createdAt: ago(hours: 20)),
            ]
        ),
        Conversation(
            id: "astra",
            title: "Astra",
            typeLabel: "Front door",
            icon: .logo(FrontDoor.codex.logo),
            provider: .codex,
            frontDoor: .codex,
            lastActivityAt: ago(hours: 30),
            messages: [
                ChatMessage(id: "c1", sender: .user, text: "Open the Orbit session and check the networking bug.", createdAt: ago(hours: 30, minutes: 1)),
                ChatMessage(id: "c2", sender: .agent, text: "Resumed Orbit. The reconnect loop never backs off after a timeout; I've drafted a fix with exponential backoff.", createdAt: ago(hours: 30)),
            ]
        ),
        Conversation(
            id: "orbit",
            title: "Orbit",
            typeLabel: "Codex session",
            icon: .symbol("chevron.left.forwardslash.chevron.right"),
            provider: .codex,
            lastActivityAt: ago(hours: 29),
            messages: [
                ChatMessage(id: "r1", sender: .agent, text: "Backoff fix is in. Tests pass locally; want me to push the branch?", createdAt: ago(hours: 29)),
            ]
        ),
        Conversation(
            id: "recipes",
            title: "Recipe Box",
            typeLabel: "Chat session",
            icon: .symbol("fork.knife"),
            provider: .claude,
            lastActivityAt: ago(hours: 75),
            messages: [
                ChatMessage(id: "w1", sender: .agent, text: "Recipe import now handles fractions like ½ cup.", createdAt: ago(hours: 75)),
            ]
        ),
    ]

    static let sessions: [AgentSession] = [
        AgentSession(key: "claude:training", provider: .claude, title: "Claude Training Session", projectName: "helix-train", lastActivityAt: ago(minutes: 1), live: true, liveStatus: .busy, managed: true),
        AgentSession(key: "claude:cat", provider: .claude, title: "Cat Diffusion", projectName: "cat-diffusion", lastActivityAt: ago(minutes: 12), live: true, liveStatus: .idle, managed: false),
        AgentSession(key: "codex:orbit", provider: .codex, title: "Orbit", projectName: "orbit", lastActivityAt: ago(hours: 29), live: false, liveStatus: nil, managed: true),
    ]

    static let watchers: [Watcher] = [
        Watcher(id: "w-train", name: "Training run", summary: "Healthy • step 84,231", severity: .info, lastEventAt: ago(minutes: 3)),
        Watcher(id: "w-disk", name: "Disk C:", summary: "62% used", severity: .info, lastEventAt: ago(minutes: 10)),
        Watcher(id: "w-deploy", name: "Orbit deploy", summary: "Last run failed", severity: .important, lastEventAt: ago(hours: 26)),
    ]

    static let approvals: [Approval] = [
        Approval(
            id: "a1",
            sessionTitle: "Claude Training Session",
            tool: "Bash",
            summary: "Delete checkpoints/old-run-17 (14.2 GB)",
            reasons: ["Recursive delete", "Frees space for the next checkpoint"],
            status: .pending,
            createdAt: ago(minutes: 4),
            expiresAt: fromNow(minutes: 26)
        ),
        Approval(
            id: "a2",
            sessionTitle: "Orbit",
            tool: "git clean",
            summary: "Remove 38 untracked files in orbit/",
            reasons: ["Git can't restore untracked files"],
            status: .pending,
            createdAt: ago(minutes: 12),
            expiresAt: fromNow(minutes: 18)
        ),
        Approval(
            id: "a3",
            sessionTitle: "Cat Diffusion",
            tool: "sqlite",
            summary: "Drop table scratch_metrics",
            reasons: ["Database DROP"],
            status: .approved,
            createdAt: ago(hours: 22),
            expiresAt: ago(hours: 21, minutes: 30),
            resolvedAt: ago(hours: 21, minutes: 58)
        ),
    ]

    static let calls: [Call] = [
        Call(id: "k1", direction: .outgoing, status: .ended, severity: .info, title: "Call Claude", summary: "Checked on the training run", provider: .claude, createdAt: ago(hours: 2, minutes: 30), duration: 252),
        Call(id: "k2", direction: .incoming, status: .ended, severity: .critical, title: "Claude", summary: "Training stopped: disk full", provider: .claude, createdAt: ago(hours: 22), duration: 95),
        Call(id: "k3", direction: .incoming, status: .missed, severity: .important, title: "Astra", summary: "Orbit deploy failed", provider: .codex, createdAt: ago(hours: 26)),
        Call(id: "k4", direction: .outgoing, status: .ended, severity: .info, title: "Call Astra", summary: "Orbit networking bug", provider: .codex, createdAt: ago(hours: 72), duration: 431),
    ]

    static let persona = PersonaSettings(
        enabled: true,
        mode: .professional,
        teasing: 0,
        flirtiness: 0,
        sarcasm: 0,
        verbosity: 0.2,
        speechRate: 0.5,
        usePCVoice: false,
        petNames: ["babe", "handsome", "trouble"]
    )
}
