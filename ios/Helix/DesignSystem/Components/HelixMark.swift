import SwiftUI

/// The gold orbit mark: two crossed orbits.
struct HelixMark: View {
    var size: CGFloat = 44

    var body: some View {
        ZStack {
            ForEach([-38.0, 38.0], id: \.self) { angle in
                Ellipse()
                    .stroke(
                        LinearGradient(
                            colors: [.goldHighlight, .gold, .goldMid],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: size * 0.085
                    )
                    .frame(width: size * 0.96, height: size * 0.46)
                    .rotationEffect(.degrees(angle))
            }
        }
        .frame(width: size, height: size)
        .shadow(color: .gold.opacity(0.5), radius: size * 0.16)
        .accessibilityHidden(true)
    }
}

#Preview {
    HelixMark(size: 120)
        .padding(40)
        .background(Color.bg)
}
