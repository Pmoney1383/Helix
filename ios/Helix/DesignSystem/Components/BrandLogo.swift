import SwiftUI

/// A provider logo from the asset catalog (template SVG), finished in champagne gold.
struct BrandLogo: View {
    let name: String
    /// Opacity of the warm glow around the mark.
    var glow: Double = 0.35

    var body: some View {
        Image(name)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .foregroundStyle(
                LinearGradient(
                    colors: [Color(hex: 0xFFD77C), Color(hex: 0xF4A735)],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .shadow(color: Color(hex: 0xF4A735).opacity(glow), radius: 7)
    }
}

#Preview {
    HStack(spacing: 32) {
        BrandLogo(name: "ClaudeLogo")
        BrandLogo(name: "OpenAILogo")
    }
    .frame(height: 64)
    .padding(40)
    .background(Color.bg)
}
