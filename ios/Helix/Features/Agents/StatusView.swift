import SwiftUI

/// "Check Status": gateway health, PC load, live agent sessions and watchers.
struct StatusView: View {
    @Environment(HelixStore.self) private var store

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                gatewayCard
                pcCard
                sessionsCard
                watchersCard
            }
            .padding(.horizontal, Spacing.screen)
            .padding(.vertical, Spacing.md)
        }
        .background(Color.bg.ignoresSafeArea())
        .refreshable { await store.refreshStatus() }
        .task {
            // Live while the screen is open: refresh now and every 10 s until it closes.
            while !Task.isCancelled {
                await store.refreshStatus()
                try? await Task.sleep(for: .seconds(10))
            }
        }
        .navigationTitle("Status")
        .navigationBarTitleDisplayMode(.large)
    }

    private var gatewayCard: some View {
        HStack(spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: 4) {
                Text(store.gateway.hostName)
                    .font(.headline)
                    .foregroundStyle(.textPrimary)
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Text("Last heartbeat \(RelativeTime.short(from: store.gateway.lastHeartbeat, to: context.date))")
                        .font(.footnote)
                        .foregroundStyle(.textSecondary)
                }
                if let up = store.gatewayUptimeSec {
                    Text("Gateway up \(Self.duration(up))")
                        .font(.footnote)
                        .foregroundStyle(.textSecondary)
                }
            }
            Spacer(minLength: Spacing.sm)
            StatusPill(isOnline: store.gateway.isOnline)
        }
        .padding(Spacing.lg)
        .helixCard(radius: Radius.tile)
        .accessibilityElement(children: .combine)
    }

    private var pcCard: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            SectionHeader(title: "This PC")
            if !store.isPaired {
                meters(cpu: store.pc.cpu, gpu: store.pc.gpu, gpuName: store.pc.gpuName, memory: store.pc.memory)
            } else if let report = store.pcReport {
                let card = report.gpu?.gpus?.first
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    meters(
                        cpu: Double(report.pc.cpu.usagePercent ?? 0) / 100,
                        gpu: (card?.utilizationPercent ?? 0) / 100,
                        gpuName: card?.name,
                        memory: report.pc.memory.usedFraction
                    )
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        detail("Uptime", Self.duration(Int(report.pc.uptimeHours * 3600)))
                        if let model = report.pc.cpu.model { detail("CPU", "\(model) · \(report.pc.cpu.cores) threads") }
                        detail("Memory", String(format: "%.1f of %.1f GB used", report.pc.memory.totalGB - report.pc.memory.freeGB, report.pc.memory.totalGB))
                        if let card {
                            detail("GPU memory", String(format: "%.1f of %.1f GB", card.memoryUsedMB / 1024, card.memoryTotalMB / 1024))
                            detail("GPU", String(format: "%.0f°C · %.0f W", card.temperatureC, card.powerW))
                        } else if let gpu = report.gpu, !gpu.available {
                            detail("GPU", gpu.error ?? "Not available")
                        }
                        ForEach(report.pc.disks) { disk in
                            detail("Disk \(disk.drive)", String(format: "%.0f GB free of %.0f GB", disk.freeGB, disk.totalGB))
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Spacing.lg)
                .helixCard(radius: Radius.tile)
            } else {
                Text(store.pcStatusError ?? "Reading the PC…")
                    .font(.subheadline)
                    .foregroundStyle(.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Spacing.lg)
                    .helixCard(radius: Radius.tile)
            }
        }
    }

    private func meters(cpu: Double, gpu: Double, gpuName: String?, memory: Double) -> some View {
        AdaptiveRow(spacing: Spacing.lg) {
            Meter(title: "CPU", value: cpu)
            Meter(title: "GPU", value: gpu, caption: gpuName)
            Meter(title: "Memory", value: memory)
        }
        .frame(maxWidth: .infinity)
    }

    private func detail(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.footnote).foregroundStyle(.textSecondary)
            Spacer(minLength: Spacing.md)
            Text(value).font(.footnote.weight(.medium)).foregroundStyle(.textPrimary).multilineTextAlignment(.trailing)
        }
        .accessibilityElement(children: .combine)
    }

    private static func duration(_ seconds: Int) -> String {
        let days = seconds / 86_400, hours = seconds % 86_400 / 3600, minutes = seconds % 3600 / 60
        if days > 0 { return "\(days)d \(hours)h" }
        if hours > 0 { return "\(hours)h \(minutes)m" }
        return "\(max(minutes, 0))m"
    }

    private var sessionsCard: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            SectionHeader(title: "Agent Sessions")
            if store.isLoadingSessions { ProgressView("Loading sessions…") }
            if let error = store.sessionsError {
                Text(error).font(.subheadline).foregroundStyle(.textSecondary)
                Button("Retry") { Task { await store.syncAgentSessions() } }.frame(minHeight: 44)
            }
            CardList(items: store.sessions) { session in
                NavigationLink {
                    ChatDetailView(conversationID: store.sessionConversationID(session))
                } label: {
                HStack(spacing: Spacing.md) {
                    Circle()
                        .fill(dotColor(session))
                        .frame(width: 10, height: 10)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.textPrimary)
                        Text([session.provider == .claude ? "Claude" : "Codex", session.projectName].compactMap(\.self).joined(separator: " • "))
                            .font(.footnote)
                            .foregroundStyle(.textSecondary)
                    }
                    Spacer(minLength: Spacing.sm)
                    Text(stateLabel(session))
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(session.liveStatus == .busy ? Color.goldText : Color.textSecondary)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.textSecondary)
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 44)
                .accessibilityElement(children: .combine)
                }
                .disabled(!store.isPaired)
                .accessibilityHint("Open session history and chat")
            }
        }
    }

    private var watchersCard: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            SectionHeader(title: "Watchers")
            if store.watchers.isEmpty {
                Text("No watchers yet. Agents add them when they start a long job.")
                    .font(.subheadline)
                    .foregroundStyle(.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Spacing.lg)
                    .helixCard(radius: Radius.tile)
            }
            CardList(items: store.watchers) { watcher in
                HStack(spacing: Spacing.md) {
                    Image(systemName: watcher.severity == .info ? "eye" : "exclamationmark.triangle.fill")
                        .foregroundStyle(watcher.severity == .info ? Color.textSecondary : Color.gold)
                        .frame(width: 24)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(watcher.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.textPrimary)
                        Text(watcher.summary)
                            .font(.footnote)
                            .foregroundStyle(.textSecondary)
                    }
                    Spacer(minLength: Spacing.sm)
                    Text(RelativeTime.short(from: watcher.lastEventAt))
                        .font(.footnote)
                        .foregroundStyle(.textSecondary)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func dotColor(_ session: AgentSession) -> Color {
        guard session.live else { return .textMuted.opacity(0.4) }
        return session.liveStatus == .busy ? .gold : .online
    }

    private func stateLabel(_ session: AgentSession) -> String {
        guard session.live else { return "Stopped" }
        return session.liveStatus == .busy ? "Working" : "Idle"
    }
}

private struct Meter: View {
    let title: String
    let value: Double
    var caption: String?

    var body: some View {
        VStack(spacing: Spacing.sm) {
            Gauge(value: value) {
                Text(title)
            } currentValueLabel: {
                Text(value, format: .percent.precision(.fractionLength(0)))
                    .font(.footnote.weight(.semibold).monospacedDigit())
            }
            .gaugeStyle(.accessoryCircularCapacity)
            .tint(value > 0.9 ? Color.gold : Color.goldMid)
            .scaleEffect(1.15)
            .padding(.vertical, Spacing.xs)

            VStack(spacing: 0) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.textPrimary)
                if let caption {
                    Text(caption)
                        .font(.caption)
                        .foregroundStyle(.textSecondary)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(Text(value, format: .percent.precision(.fractionLength(0))))
    }
}

/// Rows inside one card, separated by hairlines.
struct CardList<Item: Identifiable, Row: View>: View {
    let items: [Item]
    @ViewBuilder var row: (Item) -> Row

    var body: some View {
        VStack(spacing: 0) {
            ForEach(items) { item in
                row(item)
                    .padding(.vertical, Spacing.md)
                if item.id != items.last?.id {
                    Divider().overlay(Color.borderWarm.opacity(0.6))
                }
            }
        }
        .padding(.horizontal, Spacing.lg)
        .helixCard(radius: Radius.tile)
    }
}

#Preview {
    NavigationStack {
        StatusView()
    }
    .environment(HelixStore())
}
