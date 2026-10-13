import SwiftUI

/// Secondary shortcut tiles (Check Status, Approvals).
struct ActionTile: View {
    let title: String
    let subtitle: String
    let systemImage: String
    var badge: Int = 0

    var body: some View {
        HStack(spacing: 10) {
            IconTile(icon: .symbol(systemImage), size: 40)
                .overlay(alignment: .topTrailing) {
                    if badge > 0 {
                        Text(badge, format: .number)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.onGold)
                            .padding(.horizontal, 5)
                            .frame(minWidth: 18, minHeight: 18)
                            .background(Color.gold, in: .capsule)
                            .offset(x: 6, y: -6)
                    }
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.textPrimary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.textSecondary)
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .helixCard(radius: Radius.tile)
        .contentShape(.rect(cornerRadius: Radius.tile))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(badge > 0 ? "\(title), \(badge) pending" : title)
        .accessibilityHint(subtitle)
    }
}

#Preview {
    AdaptiveRow {
        ActionTile(title: "Check Status", subtitle: "See system health", systemImage: "chart.bar.fill")
        ActionTile(title: "Approvals", subtitle: "Review pending items", systemImage: "checkmark.shield", badge: 2)
    }
    .padding()
    .background(Color.bg)
}
