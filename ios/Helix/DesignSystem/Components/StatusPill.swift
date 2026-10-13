import SwiftUI

struct StatusPill: View {
    let isOnline: Bool

    var body: some View {
        HStack(spacing: Spacing.sm) {
            Circle()
                .fill(isOnline ? Color.online : Color.textMuted)
                .frame(width: 8, height: 8)
                .shadow(color: .online.opacity(isOnline ? 0.8 : 0), radius: 4)
            Text(isOnline ? "Gateway Online" : "Gateway Offline")
                .font(.footnote.weight(.medium))
                .foregroundStyle(.textPrimary)
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.sm)
        .background(isOnline ? Color.onlineBg : Color.surfaceSecondary, in: .capsule)
        .overlay {
            Capsule().strokeBorder((isOnline ? Color.online : Color.borderWarm).opacity(0.25), lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    VStack {
        StatusPill(isOnline: true)
        StatusPill(isOnline: false)
    }
    .padding()
    .background(Color.bg)
}
