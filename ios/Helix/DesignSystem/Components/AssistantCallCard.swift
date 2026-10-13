import SwiftUI

// MARK: - Theme

/// Visual recipe for one assistant's call card: dark smoked glass lit by gold, never filled with it.
struct AssistantCardTheme {
    enum Variant {
        /// Warmer and more radiant: starburst halo, brighter energy sweep.
        case claude
        /// Cooler and more technical: orbit paths, ring ticks, star dust.
        case astra
    }

    var variant: Variant
    var background: [Gradient.Stop]
    /// Peak opacity of the glow behind the icon.
    var iconGlow: Double
    /// Strength multiplier for the localized background blooms.
    var ambient: Double
    /// Strength multiplier for the lower energy sweep.
    var sweep: Double

    static let claude = AssistantCardTheme(
        variant: .claude,
        background: [
            .init(color: Color(hex: 0x2B261E), location: 0),
            .init(color: Color(hex: 0x24201A), location: 0.2),
            .init(color: Color(hex: 0x1C1B19), location: 0.58),
            .init(color: Color(hex: 0x121313), location: 1),
        ],
        iconGlow: 0.3,
        ambient: 1,
        sweep: 1
    )

    static let astra = AssistantCardTheme(
        variant: .astra,
        background: [
            .init(color: Color(hex: 0x25211C), location: 0),
            .init(color: Color(hex: 0x1D1B18), location: 0.2),
            .init(color: Color(hex: 0x151515), location: 0.58),
            .init(color: Color(hex: 0x0E0F10), location: 1),
        ],
        iconGlow: 0.23,
        ambient: 0.8,
        sweep: 0.95
    )

    static func of(_ door: FrontDoor) -> AssistantCardTheme {
        door == .claude ? .claude : .astra
    }

    static let radius: CGFloat = 26

    static let gold = Color(hex: 0xD99B38)
    static let goldBright = Color(hex: 0xFFD77C)
    static let goldDeep = Color(hex: 0xA96820)
    static let line = Color(hex: 0xD4942C)
    static let spark = Color(hex: 0xFFF0C8)
    static let glowCore = Color(hex: 0xFFB747)
    static let glowMid = Color(hex: 0xDA9129)
    static let title = Color(hex: 0xF7F3EA)
    static let subtitle = Color(hex: 0xA99F8E)
    static let chevron = Color(hex: 0xFFE0A0)

    static let border = LinearGradient(
        stops: [
            .init(color: Color(hex: 0x8A571C), location: 0),
            .init(color: Color(hex: 0xD99B38), location: 0.38),
            .init(color: Color(hex: 0xFFD77C), location: 0.72),
            .init(color: Color(hex: 0xFFE3A3), location: 0.86),
            .init(color: Color(hex: 0xA96820), location: 1),
        ],
        startPoint: .bottomLeading,
        endPoint: .topTrailing
    )
}

// MARK: - Card

/// The Call Claude / Call Astra cards on Home and Calls.
struct AssistantCallCard: View {
    let theme: AssistantCardTheme
    let title: String
    let subtitle: String
    let logo: String
    let action: () -> Void

    @ScaledMetric(relativeTo: .body) private var iconSlot: CGFloat = 32
    @ScaledMetric(relativeTo: .body) private var logoSize: CGFloat = 26
    @ScaledMetric(relativeTo: .body) private var chevronSize: CGFloat = 32

    private let padding: CGFloat = 12

    init(theme: AssistantCardTheme, title: String, subtitle: String, logo: String, action: @escaping () -> Void) {
        self.theme = theme
        self.title = title
        self.subtitle = subtitle
        self.logo = logo
        self.action = action
    }

    init(door: FrontDoor, action: @escaping () -> Void) {
        self.init(theme: .of(door), title: door.callTitle, subtitle: door.callSubtitle, logo: door.logo, action: action)
    }

    var body: some View {
        Button(action: action) {
            ViewThatFits(in: .horizontal) {
                content(showsChevron: true)
                content(showsChevron: false)
            }
            .padding(.horizontal, padding)
            .padding(.vertical, Spacing.md)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .frame(minHeight: 84)
        }
        .buttonStyle(AssistantCardStyle(theme: theme, anchor: HaloAnchor(x: padding + iconSlot / 2, radius: iconSlot / 2 + 11)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityHint(subtitle)
        .accessibilityAddTraits(.isButton)
    }

    private func content(showsChevron: Bool) -> some View {
        HStack(spacing: 10) {
            BrandLogo(name: logo, glow: theme.variant == .claude ? 0.5 : 0.4)
                .shadow(color: AssistantCardTheme.glowCore.opacity(0.25), radius: 12)
                .frame(width: logoSize, height: logoSize)
                .frame(width: iconSlot, height: iconSlot)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AssistantCardTheme.title)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(AssistantCardTheme.subtitle)
            }
            .shadow(color: .black.opacity(0.55), radius: 4)
            .lineLimit(showsChevron ? 1 : nil)
            .frame(maxWidth: .infinity, alignment: .leading)

            if showsChevron {
                ChevronOrbButton(size: chevronSize)
            }
        }
    }
}

private struct AssistantCardStyle: ButtonStyle {
    let theme: AssistantCardTheme
    let anchor: HaloAnchor

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed

        configuration.label
            .background { AssistantCardSurface(theme: theme, anchor: anchor, pressed: pressed) }
            .overlay { PremiumBorderLayer(pressed: pressed) }
            .contentShape(RoundedRectangle(cornerRadius: AssistantCardTheme.radius, style: .continuous))
            .scaleEffect(pressed && !reduceMotion ? 0.985 : 1)
            .animation(.easeOut(duration: 0.15), value: pressed)
    }
}

/// Everything behind the content, composited back to front and clipped to the card.
private struct AssistantCardSurface: View {
    let theme: AssistantCardTheme
    let anchor: HaloAnchor
    let pressed: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: AssistantCardTheme.radius, style: .continuous)
        let boost = pressed ? 1.35 : 1

        ZStack {
            CardBaseLayer(theme: theme)
            AmbientGlowLayer(theme: theme, anchor: anchor, boost: boost)
            GlassDepthLayer()
            OrbitCanvasLayer(theme: theme, anchor: anchor)
            EnergySweepLayer(theme: theme, anchor: anchor, boost: boost)
            switch theme.variant {
            case .claude: ClaudeHaloLayer(theme: theme, anchor: anchor, boost: boost)
            case .astra: AstraHaloLayer(theme: theme, anchor: anchor, boost: boost)
            }
            GlowingNodesLayer(theme: theme, anchor: anchor)
            TopBloomLayer()
            SparkAccentsLayer(theme: theme, anchor: anchor)
            Color.white.opacity(pressed ? 0.035 : 0)
        }
        .drawingGroup()
        .clipShape(shape)
        .background {
            shape
                .fill(Color.black)
                .shadow(color: .black.opacity(0.35), radius: 12, y: 5)
                .shadow(color: AssistantCardTheme.gold.opacity(pressed ? 0.16 : 0.1), radius: 14)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Geometry

/// Where the icon sits: its center x (y is the card's middle) and the halo ring radius.
struct HaloAnchor {
    var x: CGFloat
    var radius: CGFloat
}

/// One orbit stroke: a sweeping cubic curve or a (possibly partial) tilted ellipse.
struct OrbitPass {
    enum Kind {
        case curve(CGPoint, CGPoint, CGPoint, CGPoint)
        case ellipse(center: CGPoint, rx: CGFloat, ry: CGFloat, tilt: Double, from: Double, to: Double)
    }

    var kind: Kind
    var opacity: Double
    var width: CGFloat

    func point(at t: Double) -> CGPoint {
        switch kind {
        case let .curve(p0, c1, c2, p1):
            let mt = 1 - t
            let a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t
            return CGPoint(
                x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
                y: a * p0.y + b * c1.y + c * c2.y + d * p1.y
            )
        case let .ellipse(center, rx, ry, tilt, from, to):
            let angle = from + (to - from) * t
            let x = rx * cos(angle), y = ry * sin(angle)
            return CGPoint(
                x: center.x + x * cos(tilt) - y * sin(tilt),
                y: center.y + x * sin(tilt) + y * cos(tilt)
            )
        }
    }

    var isClosed: Bool {
        if case let .ellipse(_, _, _, _, from, to) = kind { return to - from >= 2 * .pi - 0.001 }
        return false
    }

    var path: Path {
        switch kind {
        case let .curve(p0, c1, c2, p1):
            return Path { path in
                path.move(to: p0)
                path.addCurve(to: p1, control1: c1, control2: c2)
            }
        case .ellipse:
            return Path { path in
                path.move(to: point(at: 0))
                for step in 1...96 { path.addLine(to: point(at: Double(step) / 96)) }
            }
        }
    }

    /// Gradient axis: end to end for open strokes, left to right for closed orbits.
    var axis: (start: CGPoint, end: CGPoint) {
        if case let .ellipse(center, rx, _, _, _, _) = kind, isClosed {
            return (CGPoint(x: center.x - rx, y: center.y), CGPoint(x: center.x + rx, y: center.y))
        }
        return (point(at: 0), point(at: 1))
    }

    /// Fades open strokes in and out so they read as light trails rather than drawn lines.
    func shading(_ color: Color, opacity: Double) -> GraphicsContext.Shading {
        let stops: [Gradient.Stop] = isClosed
            ? [
                .init(color: color.opacity(opacity * 0.3), location: 0),
                .init(color: color.opacity(opacity), location: 0.62),
                .init(color: color.opacity(opacity * 0.45), location: 1),
            ]
            : [
                .init(color: color.opacity(0), location: 0),
                .init(color: color.opacity(opacity * 0.7), location: 0.22),
                .init(color: color.opacity(opacity), location: 0.6),
                .init(color: color.opacity(0), location: 1),
            ]
        return .linearGradient(Gradient(stops: stops), startPoint: axis.start, endPoint: axis.end)
    }
}

struct GlowNode {
    var point: CGPoint
    var radius: CGFloat
    var intensity: Double
}

/// Shared layout for the orbit, sweep, node and spark layers so the nodes land on the lines.
struct CardGeometry {
    let size: CGSize
    let icon: CGPoint
    let halo: CGFloat
    let variant: AssistantCardTheme.Variant

    init(size: CGSize, anchor: HaloAnchor, variant: AssistantCardTheme.Variant) {
        self.size = size
        self.icon = CGPoint(x: anchor.x, y: size.height / 2)
        self.halo = anchor.radius
        self.variant = variant
    }

    private var w: CGFloat { size.width }
    private var h: CGFloat { size.height }

    var orbits: [OrbitPass] {
        switch variant {
        case .claude:
            return [
                OrbitPass(kind: .curve(CGPoint(x: -6, y: h * 0.8), CGPoint(x: w * 0.36, y: h * 0.6), CGPoint(x: w * 0.7, y: h * 0.5), CGPoint(x: w + 6, y: h * 0.04)), opacity: 0.2, width: 0.6),
                OrbitPass(kind: .ellipse(center: icon, rx: halo + 15, ry: halo + 11, tilt: 0, from: -0.4 * .pi, to: 0.42 * .pi), opacity: 0.16, width: 0.5),
                OrbitPass(kind: .curve(CGPoint(x: w * 0.16, y: h + 3), CGPoint(x: w * 0.45, y: h * 0.99), CGPoint(x: w * 0.8, y: h * 0.86), CGPoint(x: w + 4, y: h * 0.6)), opacity: 0.16, width: 0.5),
                OrbitPass(kind: .curve(CGPoint(x: icon.x + halo * 0.6, y: -3), CGPoint(x: w * 0.5, y: h * 0.12), CGPoint(x: w * 0.82, y: h * 0.32), CGPoint(x: w + 4, y: h * 0.8)), opacity: 0.1, width: 0.5),
            ]
        case .astra:
            let orbitCenter = CGPoint(x: icon.x + w * 0.25, y: icon.y + h * 0.2)
            return [
                OrbitPass(kind: .ellipse(center: orbitCenter, rx: w * 0.6, ry: h * 0.42, tilt: -0.12, from: 0, to: 2 * .pi), opacity: 0.24, width: 0.7),
                OrbitPass(kind: .ellipse(center: orbitCenter, rx: w * 0.88, ry: h * 0.72, tilt: -0.07, from: 0.95 * .pi, to: 2.15 * .pi), opacity: 0.15, width: 0.5),
                OrbitPass(kind: .curve(CGPoint(x: -4, y: h * 0.22), CGPoint(x: w * 0.3, y: h * 0.04), CGPoint(x: w * 0.66, y: -h * 0.02), CGPoint(x: w + 4, y: h * 0.16)), opacity: 0.1, width: 0.5),
                OrbitPass(kind: .ellipse(center: CGPoint(x: w * 0.86, y: h * 0.24), rx: 28, ry: 10, tilt: 0.3, from: 0.15 * .pi, to: 1.25 * .pi), opacity: 0.16, width: 0.5),
                OrbitPass(kind: .curve(CGPoint(x: w * 0.08, y: h + 2), CGPoint(x: w * 0.4, y: h * 0.88), CGPoint(x: w * 0.74, y: h * 0.92), CGPoint(x: w + 4, y: h * 0.7)), opacity: 0.12, width: 0.5),
            ]
        }
    }

    var sweep: OrbitPass {
        switch variant {
        case .claude:
            return OrbitPass(kind: .curve(CGPoint(x: icon.x - 18, y: h * 0.98), CGPoint(x: w * 0.32, y: h * 0.99), CGPoint(x: w * 0.68, y: h * 0.8), CGPoint(x: w + 8, y: h * 0.32)), opacity: 1, width: 0.8)
        case .astra:
            return OrbitPass(kind: .curve(CGPoint(x: icon.x - 10, y: h * 1.01), CGPoint(x: w * 0.38, y: h * 1.03), CGPoint(x: w * 0.72, y: h * 0.86), CGPoint(x: w + 8, y: h * 0.44)), opacity: 1, width: 0.8)
        }
    }

    func onHalo(_ angle: Double, inset: CGFloat = 0) -> CGPoint {
        CGPoint(x: icon.x + (halo + inset) * cos(angle), y: icon.y + (halo + inset) * sin(angle))
    }

    var nodes: [GlowNode] {
        let orbits = orbits
        switch variant {
        case .claude:
            return [
                GlowNode(point: sweep.point(at: 0.6), radius: 2.1, intensity: 1),
                GlowNode(point: orbits[0].point(at: 0.86), radius: 1.6, intensity: 0.75),
                GlowNode(point: onHalo(-0.3 * .pi), radius: 1.6, intensity: 0.85),
                GlowNode(point: orbits[2].point(at: 0.3), radius: 1.3, intensity: 0.55),
            ]
        case .astra:
            return [
                GlowNode(point: onHalo(-0.28 * .pi), radius: 1.9, intensity: 0.95),
                GlowNode(point: orbits[0].point(at: 0.16), radius: 1.8, intensity: 0.9),
                GlowNode(point: orbits[1].point(at: 0.62), radius: 1.4, intensity: 0.65),
                GlowNode(point: orbits[3].point(at: 0.55), radius: 1.3, intensity: 0.7),
                GlowNode(point: onHalo(0.72 * .pi), radius: 1.2, intensity: 0.55),
            ]
        }
    }
}

// MARK: - Layers

/// 1. Charcoal base: a warm multi-stop diagonal gradient, darkened toward the bottom.
private struct CardBaseLayer: View {
    let theme: AssistantCardTheme

    var body: some View {
        ZStack {
            LinearGradient(stops: theme.background, startPoint: .topLeading, endPoint: .bottomTrailing)
            LinearGradient(colors: [.clear, .black.opacity(0.18)], startPoint: .center, endPoint: .bottom)
        }
    }
}

/// 2. Localized warm blooms so the card is lit unevenly, like light falling across glass.
private struct AmbientGlowLayer: View {
    let theme: AssistantCardTheme
    let anchor: HaloAnchor
    let boost: Double

    var body: some View {
        Canvas { context, size in
            let w = size.width, h = size.height
            let icon = CGPoint(x: anchor.x, y: h / 2)
            let spots: [(center: CGPoint, radius: CGFloat, stretch: CGFloat, color: Color, opacity: Double)] = switch theme.variant {
            case .claude: [
                (icon, h * 0.7, 1.2, Color(hex: 0xC98A35), 0.1 * boost),
                (CGPoint(x: w * 0.62, y: h * 1.02), h * 0.75, 2.3, Color(hex: 0xB07A30), 0.12),
                (CGPoint(x: w * 0.94, y: 0), h * 0.6, 1.7, Color(hex: 0xD9A050), 0.09),
            ]
            case .astra: [
                (icon, h * 0.65, 1.2, Color(hex: 0xC48836), 0.08 * boost),
                (CGPoint(x: w * 0.74, y: h * 0.95), h * 0.7, 2.2, Color(hex: 0xA8752F), 0.09),
                (CGPoint(x: w * 0.42, y: h * 0.02), h * 0.55, 2.4, Color(hex: 0x8C7A60), 0.07),
            ]
            }

            for spot in spots {
                context.drawLayer { layer in
                    layer.translateBy(x: spot.center.x, y: spot.center.y)
                    layer.scaleBy(x: spot.stretch, y: 1)
                    layer.fill(
                        Path(ellipseIn: CGRect(x: -spot.radius, y: -spot.radius, width: spot.radius * 2, height: spot.radius * 2)),
                        with: .radialGradient(
                            Gradient(colors: [spot.color.opacity(spot.opacity * theme.ambient), spot.color.opacity(0)]),
                            center: .zero,
                            startRadius: 0,
                            endRadius: spot.radius
                        )
                    )
                }
            }
        }
        .blendMode(.screen)
    }
}

/// 3. Glass depth: top sheen, darker floor, a diagonal reflection and a soft vignette.
private struct GlassDepthLayer: View {
    var body: some View {
        ZStack {
            LinearGradient(
                stops: [
                    .init(color: .white.opacity(0.035), location: 0),
                    .init(color: .clear, location: 0.38),
                    .init(color: .clear, location: 0.62),
                    .init(color: .black.opacity(0.22), location: 1),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            LinearGradient(
                stops: [
                    .init(color: .clear, location: 0.22),
                    .init(color: .white.opacity(0.035), location: 0.4),
                    .init(color: .clear, location: 0.54),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .blendMode(.screen)
            EllipticalGradient(colors: [.clear, .black.opacity(0.26)], center: .center, startRadiusFraction: 0.42, endRadiusFraction: 0.75)
        }
    }
}

/// 4. Faint orbit passes, each with a soft glow beneath a crisp hairline.
private struct OrbitCanvasLayer: View {
    let theme: AssistantCardTheme
    let anchor: HaloAnchor

    var body: some View {
        Canvas { context, size in
            let geometry = CardGeometry(size: size, anchor: anchor, variant: theme.variant)
            for orbit in geometry.orbits {
                let path = orbit.path
                context.drawLayer { layer in
                    layer.addFilter(.blur(radius: 2))
                    layer.stroke(path, with: orbit.shading(AssistantCardTheme.line, opacity: orbit.opacity * 0.6), lineWidth: orbit.width * 3)
                }
                context.stroke(path, with: orbit.shading(AssistantCardTheme.goldBright, opacity: orbit.opacity), lineWidth: orbit.width)
            }
        }
        .blendMode(.plusLighter)
    }
}

/// 6. The bright energy arc across the lower third: wide bloom, mid glow, hot core.
private struct EnergySweepLayer: View {
    let theme: AssistantCardTheme
    let anchor: HaloAnchor
    let boost: Double

    var body: some View {
        Canvas { context, size in
            let sweep = CardGeometry(size: size, anchor: anchor, variant: theme.variant).sweep
            let path = sweep.path
            let strength = theme.sweep * boost
            let axis = sweep.axis

            func shading(_ color: Color, _ opacity: Double) -> GraphicsContext.Shading {
                .linearGradient(
                    Gradient(stops: [
                        .init(color: color.opacity(0), location: 0),
                        .init(color: color.opacity(opacity * 0.3), location: 0.2),
                        .init(color: color.opacity(opacity), location: 0.6),
                        .init(color: color.opacity(opacity * 0.5), location: 0.85),
                        .init(color: color.opacity(0), location: 1),
                    ]),
                    startPoint: axis.start,
                    endPoint: axis.end
                )
            }

            context.drawLayer { layer in
                layer.addFilter(.blur(radius: 7))
                layer.stroke(path, with: shading(AssistantCardTheme.gold, 0.5 * strength), lineWidth: 7)
            }
            context.drawLayer { layer in
                layer.addFilter(.blur(radius: 1.6))
                layer.stroke(path, with: shading(AssistantCardTheme.goldBright, 0.65 * strength), lineWidth: 1.8)
            }
            context.stroke(path, with: shading(AssistantCardTheme.spark, 0.9 * strength), lineWidth: 0.7)
        }
        .blendMode(.plusLighter)
    }
}

/// 5. Nodes riding the orbits: a soft halo, bloom and a hot core; the brightest gets a flare.
private struct GlowingNodesLayer: View {
    let theme: AssistantCardTheme
    let anchor: HaloAnchor

    var body: some View {
        Canvas { context, size in
            let nodes = CardGeometry(size: size, anchor: anchor, variant: theme.variant).nodes
            for node in nodes {
                let haloRadius = node.radius * 5
                context.fill(
                    Path(ellipseIn: CGRect(x: node.point.x - haloRadius, y: node.point.y - haloRadius, width: haloRadius * 2, height: haloRadius * 2)),
                    with: .radialGradient(
                        Gradient(colors: [AssistantCardTheme.glowCore.opacity(0.5 * node.intensity), AssistantCardTheme.glowCore.opacity(0)]),
                        center: node.point,
                        startRadius: 0,
                        endRadius: haloRadius
                    )
                )

                if node.intensity >= 0.95 {
                    let flare = node.radius * 7
                    for (dx, dy) in [(flare, 0.0), (0.0, flare * 0.6)] {
                        var line = Path()
                        line.move(to: CGPoint(x: node.point.x - dx, y: node.point.y - dy))
                        line.addLine(to: CGPoint(x: node.point.x + dx, y: node.point.y + dy))
                        context.stroke(
                            line,
                            with: .linearGradient(
                                Gradient(colors: [.clear, AssistantCardTheme.spark.opacity(0.55), .clear]),
                                startPoint: CGPoint(x: node.point.x - dx, y: node.point.y - dy),
                                endPoint: CGPoint(x: node.point.x + dx, y: node.point.y + dy)
                            ),
                            lineWidth: 0.5
                        )
                    }
                }

                context.drawLayer { layer in
                    layer.addFilter(.shadow(color: AssistantCardTheme.goldBright.opacity(0.7 * node.intensity), radius: 4))
                    layer.fill(
                        Path(ellipseIn: CGRect(x: node.point.x - node.radius, y: node.point.y - node.radius, width: node.radius * 2, height: node.radius * 2)),
                        with: .color(AssistantCardTheme.spark.opacity(0.6 + 0.4 * node.intensity))
                    )
                }
            }
        }
        .blendMode(.plusLighter)
    }
}

/// Glow, inner light and the lit halo ring shared by both icon halos.
private func drawHaloBase(
    in context: inout GraphicsContext,
    center: CGPoint,
    radius: CGFloat,
    glow: Double,
    glowReach: CGFloat
) {
    let reach = radius * glowReach
    context.fill(
        Path(ellipseIn: CGRect(x: center.x - reach, y: center.y - reach, width: reach * 2, height: reach * 2)),
        with: .radialGradient(
            Gradient(stops: [
                .init(color: AssistantCardTheme.glowCore.opacity(glow), location: 0),
                .init(color: AssistantCardTheme.glowMid.opacity(glow * 0.35), location: 0.42),
                .init(color: AssistantCardTheme.glowMid.opacity(0), location: 1),
            ]),
            center: center,
            startRadius: 0,
            endRadius: reach
        )
    )

    let inner = radius * 0.62
    context.fill(
        Path(ellipseIn: CGRect(x: center.x - inner, y: center.y - inner, width: inner * 2, height: inner * 2)),
        with: .radialGradient(
            Gradient(colors: [Color(hex: 0xFFE9B8).opacity(0.18), .clear]),
            center: center,
            startRadius: 0,
            endRadius: inner
        )
    )

    let ring = Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
    let ringShading = GraphicsContext.Shading.linearGradient(
        Gradient(colors: [AssistantCardTheme.gold.opacity(0.12), AssistantCardTheme.goldBright.opacity(0.5)]),
        startPoint: CGPoint(x: center.x - radius, y: center.y + radius),
        endPoint: CGPoint(x: center.x + radius, y: center.y - radius)
    )
    context.drawLayer { layer in
        layer.addFilter(.blur(radius: 3))
        layer.stroke(ring, with: ringShading, lineWidth: 2.5)
    }
    context.stroke(ring, with: ringShading, lineWidth: 0.8)
}

/// 7a. Claude: radiant glow with a fine starburst behind the mark.
private struct ClaudeHaloLayer: View {
    let theme: AssistantCardTheme
    let anchor: HaloAnchor
    let boost: Double

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: anchor.x, y: size.height / 2)
            let radius = anchor.radius
            drawHaloBase(in: &context, center: center, radius: radius, glow: theme.iconGlow * boost, glowReach: 1.5)

            var rays = Path()
            var longRays = Path()
            let count = 44
            for index in 0..<count {
                let angle = Double(index) / Double(count) * 2 * .pi
                let variation = Double((index * 37) % 11) / 10
                let inner = radius * 0.55
                let outer = radius * (0.88 + 0.5 * variation)
                let start = CGPoint(x: center.x + inner * cos(angle), y: center.y + inner * sin(angle))
                let end = CGPoint(x: center.x + outer * cos(angle), y: center.y + outer * sin(angle))
                if variation > 0.6 {
                    longRays.move(to: start)
                    longRays.addLine(to: end)
                } else {
                    rays.move(to: start)
                    rays.addLine(to: end)
                }
            }
            let rayShading = GraphicsContext.Shading.radialGradient(
                Gradient(colors: [AssistantCardTheme.goldBright.opacity(0.32), AssistantCardTheme.gold.opacity(0)]),
                center: center,
                startRadius: radius * 0.5,
                endRadius: radius * 1.4
            )
            context.drawLayer { layer in
                layer.addFilter(.blur(radius: 1.5))
                layer.stroke(longRays, with: rayShading, lineWidth: 1.4)
            }
            context.stroke(rays, with: rayShading, lineWidth: 0.45)
            context.stroke(longRays, with: rayShading, lineWidth: 0.6)

            let outerRing = radius + 7
            context.stroke(
                Path(ellipseIn: CGRect(x: center.x - outerRing, y: center.y - outerRing, width: outerRing * 2, height: outerRing * 2)),
                with: .color(AssistantCardTheme.gold.opacity(0.08)),
                lineWidth: 0.5
            )
        }
        .blendMode(.plusLighter)
    }
}

/// 7b. Astra: an orbital halo with a lit arc, ticks, a dashed outer ring and a tilted inner orbit.
private struct AstraHaloLayer: View {
    let theme: AssistantCardTheme
    let anchor: HaloAnchor
    let boost: Double

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: anchor.x, y: size.height / 2)
            let radius = anchor.radius
            drawHaloBase(in: &context, center: center, radius: radius, glow: theme.iconGlow * boost, glowReach: 1.4)

            var litArc = Path()
            litArc.addArc(center: center, radius: radius, startAngle: .radians(-0.78 * .pi), endAngle: .radians(-0.36 * .pi), clockwise: false)
            context.drawLayer { layer in
                layer.addFilter(.blur(radius: 2))
                layer.stroke(litArc, with: .color(AssistantCardTheme.goldBright.opacity(0.5)), lineWidth: 2)
            }
            context.stroke(litArc, with: .color(AssistantCardTheme.goldBright.opacity(0.7)), lineWidth: 1)

            var ticks = Path()
            for index in 0..<4 {
                let angle = Double(index) * .pi / 2 + .pi / 4
                ticks.move(to: CGPoint(x: center.x + (radius + 2) * cos(angle), y: center.y + (radius + 2) * sin(angle)))
                ticks.addLine(to: CGPoint(x: center.x + (radius + 5) * cos(angle), y: center.y + (radius + 5) * sin(angle)))
            }
            context.stroke(ticks, with: .color(AssistantCardTheme.goldBright.opacity(0.32)), lineWidth: 0.6)

            let dashed = radius + 8
            context.stroke(
                Path(ellipseIn: CGRect(x: center.x - dashed, y: center.y - dashed, width: dashed * 2, height: dashed * 2)),
                with: .color(AssistantCardTheme.gold.opacity(0.2)),
                style: StrokeStyle(lineWidth: 0.5, dash: [1, 3.2])
            )

            let inner = OrbitPass(
                kind: .ellipse(center: center, rx: radius + 12, ry: radius * 0.42, tilt: -0.5, from: 0, to: 2 * .pi),
                opacity: 0.22,
                width: 0.55
            )
            context.stroke(inner.path, with: inner.shading(AssistantCardTheme.goldBright, opacity: inner.opacity), lineWidth: inner.width)
        }
        .blendMode(.plusLighter)
    }
}

/// 11. A soft haze of light falling on the upper edge.
private struct TopBloomLayer: View {
    var body: some View {
        EllipticalGradient(
            colors: [Color(hex: 0xFFD995).opacity(0.07), .clear],
            center: UnitPoint(x: 0.62, y: 0),
            startRadiusFraction: 0,
            endRadiusFraction: 0.5
        )
        .blendMode(.screen)
    }
}

/// 12. Tiny sparks: dust along Claude's sweep, scattered stars for Astra.
private struct SparkAccentsLayer: View {
    let theme: AssistantCardTheme
    let anchor: HaloAnchor

    var body: some View {
        Canvas { context, size in
            let geometry = CardGeometry(size: size, anchor: anchor, variant: theme.variant)
            let sparks: [(point: CGPoint, radius: CGFloat, opacity: Double)] = switch theme.variant {
            case .claude: [
                (geometry.sweep.point(at: 0.42).applying(.init(translationX: 0, y: -3)), 0.7, 0.55),
                (geometry.sweep.point(at: 0.72).applying(.init(translationX: 2, y: 3)), 0.6, 0.45),
                (geometry.sweep.point(at: 0.8).applying(.init(translationX: -3, y: -4)), 0.5, 0.35),
                (CGPoint(x: size.width * 0.86, y: size.height * 0.2), 0.6, 0.35),
            ]
            case .astra: [
                (CGPoint(x: size.width * 0.52, y: size.height * 0.14), 0.6, 0.4),
                (CGPoint(x: size.width * 0.7, y: size.height * 0.8), 0.5, 0.35),
                (CGPoint(x: size.width * 0.34, y: size.height * 0.86), 0.55, 0.3),
                (CGPoint(x: size.width * 0.95, y: size.height * 0.55), 0.5, 0.35),
                (geometry.sweep.point(at: 0.6).applying(.init(translationX: 0, y: -3)), 0.6, 0.45),
            ]
            }

            context.drawLayer { layer in
                layer.addFilter(.shadow(color: AssistantCardTheme.goldBright.opacity(0.8), radius: 2.5))
                for spark in sparks {
                    layer.fill(
                        Path(ellipseIn: CGRect(x: spark.point.x - spark.radius, y: spark.point.y - spark.radius, width: spark.radius * 2, height: spark.radius * 2)),
                        with: .color(AssistantCardTheme.spark.opacity(spark.opacity))
                    )
                }
            }
        }
        .blendMode(.plusLighter)
    }
}

/// 8. Illuminated border: outer bloom, inner rim glow, gold stroke, top specular and an inner hairline.
private struct PremiumBorderLayer: View {
    let pressed: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: AssistantCardTheme.radius, style: .continuous)

        ZStack {
            shape
                .stroke(AssistantCardTheme.border, lineWidth: 3)
                .blur(radius: 9)
                .opacity(pressed ? 0.72 : 0.55)
            shape
                .stroke(AssistantCardTheme.border, lineWidth: 1.2)
                .blur(radius: 2.5)
                .opacity(pressed ? 0.85 : 0.65)
            shape
                .stroke(AssistantCardTheme.border, lineWidth: 9)
                .blur(radius: 6)
                .opacity(pressed ? 0.26 : 0.15)
                .clipShape(shape)
            shape
                .strokeBorder(AssistantCardTheme.border, lineWidth: pressed ? 1.4 : 1.15)
                .brightness(pressed ? 0.06 : 0)
            shape
                .strokeBorder(
                    LinearGradient(
                        stops: [
                            .init(color: .white.opacity(0.5), location: 0),
                            .init(color: .white.opacity(0), location: 0.3),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    ),
                    lineWidth: 0.6
                )
                .blendMode(.plusLighter)
            shape
                .inset(by: 2)
                .stroke(
                    LinearGradient(colors: [.white.opacity(0.08), .white.opacity(0.02)], startPoint: .top, endPoint: .bottom),
                    lineWidth: 0.5
                )
        }
        .allowsHitTesting(false)
    }
}

/// 10. The chevron as a small glass orb with its own glow, highlight and gold rim.
private struct ChevronOrbButton: View {
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle()
                .fill(AssistantCardTheme.gold.opacity(0.2))
                .blur(radius: 6)
            Circle()
                .fill(
                    RadialGradient(
                        colors: [Color(hex: 0x3D342A), Color(hex: 0x241F1A), Color(hex: 0x14120F)],
                        center: UnitPoint(x: 0.35, y: 0.3),
                        startRadius: 0,
                        endRadius: size * 0.75
                    )
                )
                .opacity(0.95)
            Circle()
                .fill(LinearGradient(colors: [.clear, .black.opacity(0.35)], startPoint: .center, endPoint: .bottom))
            Circle()
                .fill(
                    RadialGradient(
                        colors: [.white.opacity(0.18), .clear],
                        center: UnitPoint(x: 0.3, y: 0.22),
                        startRadius: 0,
                        endRadius: size * 0.45
                    )
                )
            Circle()
                .strokeBorder(
                    LinearGradient(
                        stops: [
                            .init(color: AssistantCardTheme.goldBright.opacity(0.85), location: 0),
                            .init(color: Color(hex: 0xB97825).opacity(0.55), location: 0.5),
                            .init(color: Color(hex: 0x6E4515).opacity(0.5), location: 1),
                        ],
                        startPoint: .topTrailing,
                        endPoint: .bottomLeading
                    ),
                    lineWidth: 0.9
                )
            Circle()
                .inset(by: 1.6)
                .stroke(Color.white.opacity(0.06), lineWidth: 0.5)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(AssistantCardTheme.chevron)
                .shadow(color: AssistantCardTheme.goldBright.opacity(0.7), radius: 3)
                .shadow(color: Color(hex: 0xF4A735).opacity(0.35), radius: 8)
        }
        .frame(width: size, height: size)
    }
}

#Preview {
    AdaptiveRow {
        AssistantCallCard(door: .claude) {}
        AssistantCallCard(door: .codex) {}
    }
    .padding()
    .background(Color.bg)
}
