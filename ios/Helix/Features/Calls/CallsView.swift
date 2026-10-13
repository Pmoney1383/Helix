import SwiftUI

struct CallsView: View {
    @Environment(HelixStore.self) private var store

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.xl) {
                    AdaptiveRow {
                        AssistantCallCard(door: .claude) { store.startCall(.claude) }
                        AssistantCallCard(door: .codex) { store.startCall(.codex) }
                    }

                    VStack(alignment: .leading, spacing: Spacing.md) {
                        SectionHeader(title: "Recent")
                        if store.calls.isEmpty {
                            Text("Calls you make, and calls Helix makes to you, show up here.")
                                .font(.subheadline)
                                .foregroundStyle(.textSecondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(Spacing.lg)
                                .helixCard(radius: Radius.tile)
                        } else {
                            CardList(items: store.calls) { call in
                                Button {
                                    store.startCall(call.provider == .claude ? .claude : .codex)
                                } label: {
                                    CallRow(call: call)
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint("Calls back")
                            }
                        }
                    }
                }
                .padding(.horizontal, Spacing.screen)
                .padding(.vertical, Spacing.sm)
            }
            .background(Color.bg.ignoresSafeArea())
            .onAppear { store.warmVoice() }
            .navigationTitle("Calls")
        }
    }
}

private struct CallRow: View {
    let call: Call

    var body: some View {
        HStack(spacing: Spacing.md) {
            IconTile(icon: .symbol(symbol), tint: tint)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: Spacing.xs) {
                    Text(call.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(call.status == .missed ? Color.red : Color.textPrimary)
                    if call.severity == .critical {
                        Text("Urgent")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.red)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.red.opacity(0.15), in: .capsule)
                    }
                }
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(.textSecondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            TimelineView(.periodic(from: .now, by: 60)) { context in
                Text(RelativeTime.short(from: call.createdAt, to: context.date))
                    .font(.footnote)
                    .foregroundStyle(.textSecondary)
            }
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }

    private var symbol: String {
        switch (call.direction, call.status) {
        case (_, .missed), (_, .declined): "phone.down"
        case (.incoming, _): "phone.arrow.down.left"
        case (.outgoing, _): "phone.arrow.up.right"
        }
    }

    private var tint: Color { call.status == .missed ? .red : .goldLight }

    private var subtitle: String {
        let direction = call.status == .missed ? "Missed" : (call.direction == .incoming ? "Incoming" : "Outgoing")
        let duration = call.duration.map { " • \(DurationText.short($0))" } ?? ""
        return "\(direction)\(duration) • \(call.summary)"
    }
}

#Preview {
    CallsView()
        .environment(HelixStore())
}
