import SwiftUI

struct ApprovalsView: View {
    @Environment(HelixStore.self) private var store
    @State private var confirming: Approval?
    @State private var resolvedCount = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                if store.pendingApprovals.isEmpty {
                    ContentUnavailableView(
                        "Nothing to Approve",
                        systemImage: "checkmark.shield",
                        description: Text("When an agent wants to delete something, it waits here for you.")
                    )
                    .padding(.top, Spacing.xxl)
                } else {
                    ForEach(store.pendingApprovals) { approval in
                        ApprovalCard(
                            approval: approval,
                            onApprove: { confirming = approval },
                            onReject: {
                                withAnimation { store.reject(approval.id) }
                                resolvedCount += 1
                            }
                        )
                        .transition(.opacity.combined(with: .scale(scale: 0.96)))
                    }
                }

                if !store.resolvedApprovals.isEmpty {
                    VStack(alignment: .leading, spacing: Spacing.md) {
                        SectionHeader(title: "History")
                        CardList(items: store.resolvedApprovals) { approval in
                            HStack(spacing: Spacing.md) {
                                Image(systemName: approval.status == .approved ? "checkmark.circle.fill" : "xmark.circle.fill")
                                    .foregroundStyle(approval.status == .approved ? Color.online : Color.textSecondary)
                                    .accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(approval.summary)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.textPrimary)
                                    Text("\(approval.status.rawValue.capitalized) • \(RelativeTime.short(from: approval.resolvedAt ?? approval.createdAt))")
                                        .font(.footnote)
                                        .foregroundStyle(.textSecondary)
                                }
                                Spacer(minLength: 0)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
            }
            .padding(.horizontal, Spacing.screen)
            .padding(.vertical, Spacing.md)
            .animation(.default, value: store.pendingApprovals)
        }
        .background(Color.bg.ignoresSafeArea())
        .navigationTitle("Approvals")
        .navigationBarTitleDisplayMode(.large)
        .sensoryFeedback(.success, trigger: resolvedCount)
        .confirmationDialog(
            confirming.map { "Allow \($0.sessionTitle ?? "the agent") to continue?" } ?? "",
            isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
            titleVisibility: .visible,
            presenting: confirming
        ) { approval in
            Button("Approve", role: .destructive) {
                withAnimation { store.approveWithAuth(approval.id) }
                resolvedCount += 1
            }
            Button("Cancel", role: .cancel) {}
        } message: { approval in
            Text("\(approval.summary). This can't be undone.")
        }
    }
}

private struct ApprovalCard: View {
    let approval: Approval
    let onApprove: () -> Void
    let onReject: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack(spacing: Spacing.md) {
                IconTile(icon: .symbol("trash"))
                VStack(alignment: .leading, spacing: 2) {
                    Text(approval.sessionTitle ?? "Agent")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.textPrimary)
                    Text(approval.tool)
                        .font(.footnote.monospaced())
                        .foregroundStyle(.textSecondary)
                }
                Spacer(minLength: Spacing.sm)
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Label(DurationText.short(approval.expiresAt.timeIntervalSince(context.date)), systemImage: "timer")
                        .font(.footnote.weight(.medium).monospacedDigit())
                        .foregroundStyle(.goldText)
                        .accessibilityLabel("Expires in \(DurationText.short(approval.expiresAt.timeIntervalSince(context.date)))")
                }
            }

            Text(approval.summary)
                .font(.headline)
                .foregroundStyle(.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            if !approval.reasons.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(approval.reasons, id: \.self) { reason in
                        Label(reason, systemImage: "exclamationmark.circle")
                            .font(.footnote)
                            .foregroundStyle(.textSecondary)
                    }
                }
            }

            AdaptiveRow {
                Button(action: onReject) {
                    Text("Reject")
                        .font(.headline)
                        .foregroundStyle(.textPrimary)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(Color.surfaceSecondary, in: .capsule)
                        .overlay { Capsule().strokeBorder(Color.borderWarm, lineWidth: 1) }
                }
                .buttonStyle(.pressable)

                Button(action: onApprove) {
                    Text("Approve")
                        .font(.headline)
                        .foregroundStyle(.onGold)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(.callClaude, in: .capsule)
                }
                .buttonStyle(.pressable)
            }
            .padding(.top, Spacing.xs)
        }
        .padding(Spacing.lg)
        .helixCard(fill: .surface, border: .goldMid.opacity(0.45), radius: Radius.tile)
    }
}

#Preview {
    NavigationStack {
        ApprovalsView()
    }
    .environment(HelixStore())
}
