import SwiftUI

enum TileIcon: Hashable {
    case monogram(String)
    case symbol(String)
    /// An image in the asset catalog, drawn with `BrandLogo`.
    case logo(String)
}

struct IconTile: View {
    let icon: TileIcon
    var tint: Color = .goldLight
    @ScaledMetric private var size: CGFloat

    init(icon: TileIcon, tint: Color = .goldLight, size: CGFloat = 44) {
        self.icon = icon
        self.tint = tint
        _size = ScaledMetric(wrappedValue: size, relativeTo: .body)
    }

    var body: some View {
        Group {
            switch icon {
            case .monogram(let text):
                Text(text)
                    .font(.headline.weight(.bold))
            case .symbol(let name):
                Image(systemName: name)
                    .font(.title3.weight(.medium))
            case .logo(let name):
                BrandLogo(name: name)
                    .frame(width: size * 0.52, height: size * 0.52)
            }
        }
        .foregroundStyle(tint)
        .frame(width: size, height: size)
        .background(Color.surfaceWarm, in: .rect(cornerRadius: Radius.icon))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.icon)
                .strokeBorder(Color.borderWarm.opacity(0.6), lineWidth: 1)
        }
        .accessibilityHidden(true)
    }
}

#Preview {
    HStack {
        IconTile(icon: .monogram("AI"))
        IconTile(icon: .symbol("bubble.left"))
    }
    .padding()
    .background(Color.bg)
}
