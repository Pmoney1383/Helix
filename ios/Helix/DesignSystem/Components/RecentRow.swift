import SwiftUI

struct RecentRow: View {
    let conversation: Conversation

    var body: some View {
        HStack(spacing: Spacing.md) {
            IconTile(icon: conversation.icon)
            VStack(alignment: .leading, spacing: 3) {
                Text(conversation.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.textPrimary)
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    Text("\(conversation.typeLabel) • \(RelativeTime.short(from: conversation.lastActivityAt, to: context.date))")
                        .font(.footnote)
                        .foregroundStyle(.textSecondary)
                }
            }
            Spacer(minLength: Spacing.sm)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.textSecondary)
        }
        .padding(.vertical, Spacing.md)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

struct SectionHeader<Accessory: View>: View {
    let title: String
    @ViewBuilder var accessory: Accessory

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(.textPrimary)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            accessory
        }
    }
}

extension SectionHeader where Accessory == EmptyView {
    init(title: String) {
        self.init(title: title) { EmptyView() }
    }
}

#Preview {
    VStack(spacing: 0) {
        ForEach(SampleData.conversations.prefix(2)) { conversation in
            RecentRow(conversation: conversation)
        }
    }
    .padding()
    .background(Color.bg)
}
