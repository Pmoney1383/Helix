import SwiftUI

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

extension ShapeStyle where Self == LinearGradient {
    /// Metallic gold for glyphs and marks on dark surfaces.
    static var goldFoil: LinearGradient {
        LinearGradient(
            stops: [
                .init(color: .goldHighlight, location: 0),
                .init(color: .gold, location: 0.45),
                .init(color: .goldMid, location: 0.8),
                .init(color: .goldDark, location: 1),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}

enum Radius {
    static let card: CGFloat = 24
    static let action: CGFloat = 22
    static let tile: CGFloat = 20
    static let icon: CGFloat = 12
}

enum Spacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 20
    static let xxl: CGFloat = 24
    static let screen: CGFloat = 20
}

struct HelixCard: ViewModifier {
    var fill: Color = .surface
    var border: Color = .borderWarm
    var radius: CGFloat = Radius.card

    func body(content: Content) -> some View {
        content
            .background(fill, in: .rect(cornerRadius: radius))
            .overlay {
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(border, lineWidth: 1)
            }
    }
}

extension View {
    func helixCard(fill: Color = .surface, border: Color = .borderWarm, radius: CGFloat = Radius.card) -> some View {
        modifier(HelixCard(fill: fill, border: border, radius: radius))
    }

    /// Fades content into the background under the status bar on screens without a navigation bar.
    func statusBarFade() -> some View {
        overlay(alignment: .top) {
            LinearGradient(colors: [.bg, .bg.opacity(0)], startPoint: .top, endPoint: .bottom)
                .frame(height: 12)
                .ignoresSafeArea(edges: .top)
                .allowsHitTesting(false)
        }
    }
}

/// Lays children out side by side, and stacks them once the text size reaches the accessibility range.
struct AdaptiveRow<Content: View>: View {
    var spacing: CGFloat = Spacing.md
    @ViewBuilder var content: Content
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: spacing))
            : AnyLayout(HStackLayout(alignment: .top, spacing: spacing))
        layout { content }
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// Small press feedback for custom tappable surfaces.
struct PressableStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.snappy(duration: 0.18), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == PressableStyle {
    static var pressable: PressableStyle { PressableStyle() }
}
