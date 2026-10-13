import SwiftUI

/// The hero card's artwork: a textured planet with a gold sunrise on its rim, light haze
/// climbing the right edge and gold dust, composited from separate layers.
struct HorizonGlow: View {
    /// Where the top of the planet sits, as a fraction of the height.
    var horizon: CGFloat = 0.74

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathe = false

    var body: some View {
        ZStack {
            ZStack {
                HeroBaseLayer()
                HeroAmbientLayer(horizon: horizon)
                GoldDustLayer(horizon: horizon)
                AtmosphereLayer(horizon: horizon)
                PlanetLayer(horizon: horizon)
                RimLightLayer(horizon: horizon)
                LightRaysLayer(horizon: horizon)
                HeroGlassLayer()
            }
            .drawingGroup()

            SunriseBloomLayer(horizon: horizon)
                .opacity(breathe ? 1 : 0.8)
        }
        .accessibilityHidden(true)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 4).repeatForever(autoreverses: true)) {
                breathe = true
            }
        }
    }
}

// MARK: - Geometry

/// The planet: a circle whose top touches the horizon and whose rim meets the bottom corners.
private struct HorizonGeometry {
    let size: CGSize
    let horizon: CGFloat

    var width: CGFloat { size.width }
    var height: CGFloat { size.height }
    var horizonY: CGFloat { height * horizon }
    var radius: CGFloat { width * 0.78 }
    var center: CGPoint { CGPoint(x: width * 0.5, y: horizonY + radius) }

    /// The sunrise sits a little right of center, like the light source in the mockup.
    var sun: CGPoint { CGPoint(x: width * 0.58, y: rimY(atX: width * 0.58)) }

    var planet: Path {
        Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
    }

    func rimY(atX x: CGFloat) -> CGFloat {
        let dx = x - center.x
        return center.y - sqrt(max(radius * radius - dx * dx, 0))
    }

    /// Brightest just right of center, still glowing where the rim meets the card edges.
    func rimShading(_ color: Color, peak: Double) -> GraphicsContext.Shading {
        .linearGradient(
            Gradient(stops: [
                .init(color: color.opacity(peak * 0.55), location: 0),
                .init(color: color.opacity(peak * 0.42), location: 0.24),
                .init(color: color.opacity(peak * 0.85), location: 0.47),
                .init(color: color.opacity(peak), location: 0.6),
                .init(color: color.opacity(peak * 0.75), location: 0.8),
                .init(color: color.opacity(peak * 0.65), location: 1),
            ]),
            startPoint: CGPoint(x: 0, y: 0),
            endPoint: CGPoint(x: width, y: 0)
        )
    }
}

// MARK: - Layers

/// Near-black glass, a touch lighter in the upper left.
private struct HeroBaseLayer: View {
    var body: some View {
        LinearGradient(
            stops: [
                .init(color: Color(hex: 0x1C1915), location: 0),
                .init(color: Color(hex: 0x13110E), location: 0.45),
                .init(color: Color(hex: 0x0B0A08), location: 1),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}

/// Warm haze climbing the right edge, a faint top-right bloom and warmth above the horizon.
private struct HeroAmbientLayer: View {
    let horizon: CGFloat

    var body: some View {
        Canvas { context, size in
            let g = HorizonGeometry(size: size, horizon: horizon)
            let spots: [(center: CGPoint, radius: CGFloat, sx: CGFloat, sy: CGFloat, color: Color, opacity: Double)] = [
                (CGPoint(x: g.width * 1.02, y: g.height * 0.66), g.height * 0.6, 0.7, 1.35, Color(hex: 0xD08C30), 0.46),
                (CGPoint(x: g.width * 0.92, y: 0), g.height * 0.45, 1.6, 1, Color(hex: 0xB98236), 0.12),
                (CGPoint(x: g.sun.x, y: g.horizonY), g.width * 0.62, 1, 0.42, Color(hex: 0xB97A2C), 0.26),
                (CGPoint(x: 0, y: g.height), g.height * 0.4, 1.2, 1, Color(hex: 0xC8862E), 0.2),
            ]
            for spot in spots {
                context.drawLayer { layer in
                    layer.translateBy(x: spot.center.x, y: spot.center.y)
                    layer.scaleBy(x: spot.sx, y: spot.sy)
                    layer.fill(
                        Path(ellipseIn: CGRect(x: -spot.radius, y: -spot.radius, width: spot.radius * 2, height: spot.radius * 2)),
                        with: .radialGradient(
                            Gradient(colors: [spot.color.opacity(spot.opacity), spot.color.opacity(0)]),
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

/// Gold dust, denser and brighter toward the lit right side; a few motes carry a soft glow.
private struct GoldDustLayer: View {
    let horizon: CGFloat

    var body: some View {
        Canvas { context, size in
            let g = HorizonGeometry(size: size, horizon: horizon)
            var generator = SeededGenerator(seed: 7)
            var motes: [(rect: CGRect, alpha: Double)] = []
            var glowing: [(rect: CGRect, alpha: Double)] = []

            for index in 0..<320 {
                let skew = pow(Double.random(in: 0...1, using: &generator), 1.7)
                let x = g.width * (1 - skew * 0.97)
                let y = Double.random(in: 0...(g.horizonY + 6), using: &generator)
                let side = x / g.width
                let radius = Double.random(in: 0.25...0.75, using: &generator) * (0.7 + 0.45 * side)
                let alpha = Double.random(in: 0.06...0.32, using: &generator) + 0.4 * side * side
                let rect = CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2)
                if index.isMultiple(of: 24), side > 0.55 {
                    glowing.append((rect.insetBy(dx: -0.4, dy: -0.4), min(alpha + 0.2, 1)))
                } else {
                    motes.append((rect, min(alpha, 0.85)))
                }
            }

            for mote in motes {
                context.fill(Path(ellipseIn: mote.rect), with: .color(Color(hex: 0xFFD27A).opacity(mote.alpha)))
            }
            context.drawLayer { layer in
                layer.addFilter(.shadow(color: Color(hex: 0xFFC35C).opacity(0.9), radius: 3))
                for mote in glowing {
                    layer.fill(Path(ellipseIn: mote.rect), with: .color(Color(hex: 0xFFF0C8).opacity(mote.alpha)))
                }
            }
        }
        .blendMode(.plusLighter)
    }
}

/// Wide glow above the rim; the planet drawn next hides its inner half.
private struct AtmosphereLayer: View {
    let horizon: CGFloat

    var body: some View {
        Canvas { context, size in
            let g = HorizonGeometry(size: size, horizon: horizon)
            context.drawLayer { layer in
                layer.addFilter(.blur(radius: 30))
                layer.stroke(g.planet, with: g.rimShading(Color(hex: 0xD68926), peak: 0.55), lineWidth: 70)
            }
            context.drawLayer { layer in
                layer.addFilter(.blur(radius: 12))
                layer.stroke(g.planet, with: g.rimShading(Color(hex: 0xF4A735), peak: 0.5), lineWidth: 22)
            }
        }
        .blendMode(.plusLighter)
    }
}

/// The planet body: lit from the sunrise, with soft terrain, fine grain and light scattering
/// just inside the limb.
private struct PlanetLayer: View {
    let horizon: CGFloat

    var body: some View {
        Canvas { context, size in
            let g = HorizonGeometry(size: size, horizon: horizon)
            let planet = g.planet

            context.fill(
                planet,
                with: .radialGradient(
                    Gradient(stops: [
                        .init(color: Color(hex: 0x5E411D), location: 0),
                        .init(color: Color(hex: 0x352510), location: 0.16),
                        .init(color: Color(hex: 0x17110A), location: 0.48),
                        .init(color: Color(hex: 0x080604), location: 1),
                    ]),
                    center: g.sun,
                    startRadius: 0,
                    endRadius: g.width * 0.95
                )
            )

            context.clip(to: planet)
            var generator = SeededGenerator(seed: 21)

            context.drawLayer { layer in
                layer.addFilter(.blur(radius: 1.6))
                for _ in 0..<160 {
                    let x = Double.random(in: 0...size.width, using: &generator)
                    let y = Double.random(in: (g.horizonY - 6)...size.height, using: &generator)
                    let rx = Double.random(in: 3...18, using: &generator)
                    let ry = rx * Double.random(in: 0.25...0.45, using: &generator)
                    let lit = Bool.random(using: &generator)
                    let alpha = Double.random(in: 0.04...0.1, using: &generator)
                    layer.fill(
                        Path(ellipseIn: CGRect(x: x - rx, y: y - ry, width: rx * 2, height: ry * 2)),
                        with: .color((lit ? Color(hex: 0xB9813F) : Color.black).opacity(alpha))
                    )
                }
            }

            for _ in 0..<520 {
                let x = Double.random(in: 0...size.width, using: &generator)
                let y = Double.random(in: (g.horizonY - 4)...size.height, using: &generator)
                let radius = Double.random(in: 0.35...0.8, using: &generator)
                let lit = Bool.random(using: &generator)
                let alpha = Double.random(in: 0.05...0.16, using: &generator)
                context.fill(
                    Path(ellipseIn: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2)),
                    with: .color((lit ? Color(hex: 0xE2B678) : Color.black).opacity(alpha))
                )
            }

            context.drawLayer { layer in
                layer.addFilter(.blur(radius: 10))
                layer.stroke(planet, with: g.rimShading(Color(hex: 0xE09A3A), peak: 0.6), lineWidth: 24)
            }

            context.fill(
                Path(CGRect(origin: .zero, size: size)),
                with: .linearGradient(
                    Gradient(colors: [.clear, .black.opacity(0.4)]),
                    startPoint: CGPoint(x: 0, y: g.horizonY + 10),
                    endPoint: CGPoint(x: 0, y: size.height)
                )
            )
        }
    }
}

/// The lit limb: a wide bloom, a gold glow and a hot hairline.
private struct RimLightLayer: View {
    let horizon: CGFloat

    var body: some View {
        Canvas { context, size in
            let g = HorizonGeometry(size: size, horizon: horizon)
            let planet = g.planet
            context.drawLayer { layer in
                layer.addFilter(.blur(radius: 5))
                layer.stroke(planet, with: g.rimShading(Color(hex: 0xF4A735), peak: 0.85), lineWidth: 7)
            }
            context.drawLayer { layer in
                layer.addFilter(.blur(radius: 1.4))
                layer.stroke(planet, with: g.rimShading(Color(hex: 0xFFD77C), peak: 0.95), lineWidth: 2.4)
            }
            context.stroke(planet, with: g.rimShading(Color(hex: 0xFFF3D6), peak: 1), lineWidth: 0.9)
        }
        .blendMode(.plusLighter)
    }
}

/// Faint light streaks rising from the right side of the horizon toward the upper right.
private struct LightRaysLayer: View {
    let horizon: CGFloat

    var body: some View {
        Canvas { context, size in
            let g = HorizonGeometry(size: size, horizon: horizon)
            let rays: [(x: CGFloat, length: CGFloat, slant: CGFloat, opacity: Double)] = [
                (0.76, 0.42, 0.55, 0.12),
                (0.84, 0.6, 0.66, 0.2),
                (0.9, 0.46, 0.6, 0.15),
                (0.96, 0.62, 0.72, 0.22),
            ]
            for ray in rays {
                let x = g.width * ray.x
                let start = CGPoint(x: x, y: g.rimY(atX: x) - 2)
                let length = g.height * ray.length
                let end = CGPoint(x: start.x + length * ray.slant, y: start.y - length * 0.8)
                var path = Path()
                path.move(to: start)
                path.addLine(to: end)
                let shading = GraphicsContext.Shading.linearGradient(
                    Gradient(colors: [Color(hex: 0xFFCF7A).opacity(ray.opacity), Color(hex: 0xFFCF7A).opacity(0)]),
                    startPoint: start,
                    endPoint: end
                )
                context.drawLayer { layer in
                    layer.addFilter(.blur(radius: 7))
                    layer.stroke(path, with: shading, lineWidth: 10)
                }
                context.drawLayer { layer in
                    layer.addFilter(.blur(radius: 1.5))
                    layer.stroke(path, with: shading, lineWidth: 1.2)
                }
            }
        }
        .blendMode(.plusLighter)
    }
}

/// Top sheen and a vignette that keeps the upper left (behind the text) the darkest.
private struct HeroGlassLayer: View {
    var body: some View {
        ZStack {
            LinearGradient(
                stops: [
                    .init(color: .white.opacity(0.04), location: 0),
                    .init(color: .clear, location: 0.3),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            EllipticalGradient(
                colors: [.clear, .black.opacity(0.3)],
                center: UnitPoint(x: 0.7, y: 0.75),
                startRadiusFraction: 0.35,
                endRadiusFraction: 1
            )
        }
    }
}

/// The hot spot where the sun breaks over the rim.
private struct SunriseBloomLayer: View {
    let horizon: CGFloat

    var body: some View {
        Canvas { context, size in
            let g = HorizonGeometry(size: size, horizon: horizon)
            let sun = g.sun
            context.drawLayer { layer in
                layer.addFilter(.blur(radius: 12))
                let rx = g.width * 0.3, ry: CGFloat = 16
                layer.fill(
                    Path(ellipseIn: CGRect(x: sun.x - rx, y: sun.y - ry, width: rx * 2, height: ry * 2)),
                    with: .radialGradient(
                        Gradient(colors: [Color(hex: 0xFFE7B0).opacity(0.42), Color(hex: 0xF4A735).opacity(0.2), .clear]),
                        center: sun,
                        startRadius: 0,
                        endRadius: rx
                    )
                )
            }
            context.drawLayer { layer in
                layer.addFilter(.blur(radius: 4))
                let rx = g.width * 0.13, ry: CGFloat = 4
                layer.fill(
                    Path(ellipseIn: CGRect(x: sun.x - rx, y: sun.y - ry, width: rx * 2, height: ry * 2)),
                    with: .color(Color(hex: 0xFFF6E2).opacity(0.75))
                )
            }
        }
        .blendMode(.plusLighter)
        .allowsHitTesting(false)
    }
}

/// SplitMix64, so the dust and terrain are identical on every render.
private struct SeededGenerator: RandomNumberGenerator {
    var state: UInt64

    init(seed: UInt64) { state = seed }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

#Preview {
    HorizonGlow()
        .frame(height: 280)
        .clipShape(.rect(cornerRadius: 24))
        .padding()
        .background(Color.bg)
}
