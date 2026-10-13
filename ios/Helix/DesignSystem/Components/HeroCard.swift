import SwiftUI

struct HeroCard: View {
    let update: HeroUpdate
    var onOpen: () -> Void = {}
    var onCall: () -> Void = {}
    var onHide: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack(alignment: .center) {
                Label(update.eyebrow, systemImage: "sparkle")
                    .font(.caption.weight(.semibold))
                    .tracking(0.8)
                    .textCase(.uppercase)
                    .foregroundStyle(.goldText)
                    .shadow(color: Color.gold.opacity(0.55), radius: 5)
                Spacer()
                Menu {
                    Button("Open Session", systemImage: "bubble.left", action: onOpen)
                    Button("Call About This", systemImage: "phone", action: onCall)
                    Divider()
                    Button("Hide Update", systemImage: "eye.slash", action: onHide)
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.body.weight(.bold))
                        .foregroundStyle(.textSecondary)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(.rect)
                }
                .accessibilityLabel("More")
                .padding(.trailing, -Spacing.md)
                .padding(.vertical, -Spacing.md)
            }

            VStack(alignment: .leading, spacing: Spacing.sm) {
                Text(update.title)
                    .font(.title2.bold())
                    .foregroundStyle(.textPrimary)
                Text(update.detail)
                    .font(.subheadline)
                    .foregroundStyle(.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let eta = update.estimatedCompletion {
                EstimatedCompletionRow(label: update.etaLabel, eta: eta)
                    .padding(.top, Spacing.xs)
            }

            Spacer(minLength: 52)
        }
        .padding(Spacing.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            HorizonGlow(horizon: 0.74)
                .clipShape(.rect(cornerRadius: Radius.card))
                .background {
                    RoundedRectangle(cornerRadius: Radius.card)
                        .fill(Color.black)
                        .shadow(color: .black.opacity(0.4), radius: 16, y: 6)
                        .shadow(color: Color.gold.opacity(0.1), radius: 18)
                }
        }
        .overlay { HeroBorderLayer() }
        .contentShape(.rect(cornerRadius: Radius.card))
        .onTapGesture(perform: onOpen)
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Open Session", onOpen)
    }
}

private struct EstimatedCompletionRow: View {
    let label: String
    let eta: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            HStack(spacing: Spacing.sm) {
                Image(systemName: "clock")
                    .foregroundStyle(.textSecondary)
                Text(label)
                    .foregroundStyle(.textSecondary)
                Spacer(minLength: Spacing.sm)
                Text(DurationText.short(eta.timeIntervalSince(context.date)))
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .foregroundStyle(.textPrimary)
            }
            .font(.footnote)
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.md)
            .background {
                Capsule()
                    .fill(Color.black.opacity(0.3))
                    .overlay {
                        Capsule().fill(
                            LinearGradient(
                                colors: [Color(hex: 0xFFE2A8).opacity(0.08), .clear, Color.black.opacity(0.25)],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                    }
                    .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
            }
            .overlay {
                Capsule().strokeBorder(
                    LinearGradient(
                        colors: [Color(hex: 0xFFE2A8).opacity(0.22), Color.goldMid.opacity(0.18), Color.goldMid.opacity(0.32)],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    lineWidth: 0.8
                )
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// Illuminated border: dim at the top, catching the sunrise toward the bottom and right.
private struct HeroBorderLayer: View {
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.card)
        let gradient = LinearGradient(
            stops: [
                .init(color: Color(hex: 0x6E4A1E), location: 0),
                .init(color: Color(hex: 0x8A5A20), location: 0.35),
                .init(color: Color(hex: 0xD99B38), location: 0.72),
                .init(color: Color(hex: 0xFFD77C), location: 1),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )

        ZStack {
            shape
                .stroke(gradient, lineWidth: 3)
                .blur(radius: 10)
                .opacity(0.55)
            shape
                .stroke(gradient, lineWidth: 1.2)
                .blur(radius: 2.5)
                .opacity(0.6)
            shape
                .stroke(gradient, lineWidth: 10)
                .blur(radius: 8)
                .opacity(0.28)
                .clipShape(shape)
            shape
                .strokeBorder(gradient, lineWidth: 1)
            shape
                .strokeBorder(
                    LinearGradient(
                        stops: [
                            .init(color: .white.opacity(0.28), location: 0),
                            .init(color: .white.opacity(0), location: 0.22),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    lineWidth: 0.6
                )
                .blendMode(.plusLighter)
            shape
                .inset(by: 2)
                .stroke(Color.white.opacity(0.04), lineWidth: 0.5)
        }
        .allowsHitTesting(false)
    }
}

#Preview {
    HeroCard(update: SampleData.hero)
        .padding()
        .background(Color.bg)
}
