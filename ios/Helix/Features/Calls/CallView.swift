import SwiftUI
import AVKit

/// The in-app call screen. CallKit and the speech loop plug in behind `HelixStore.activeCall`.
struct CallView: View {
    @Environment(HelixStore.self) private var store

    var body: some View {
        if let call = store.activeCall {
            ZStack {
                Color.bg.ignoresSafeArea()
                RadialGradient(
                    colors: [.goldDeep.opacity(0.35), .clear],
                    center: .center,
                    startRadius: 0,
                    endRadius: 360
                )
                .ignoresSafeArea()

                VStack(spacing: Spacing.lg) {
                    HStack {
                        Button { store.callScreenHidden = true } label: {
                            Image(systemName: "chevron.down")
                                .font(.title3.weight(.semibold))
                                .frame(width: 44, height: 44)
                        }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
                        .accessibilityLabel("Back to the app")
                        Spacer()
                    }
                    header(call)
                    Spacer()
                    CallOrb(phase: call.phase)
                    Spacer()
                    transcript(call)
                    controls
                }
                .padding(.horizontal, Spacing.xxl)
                .padding(.vertical, Spacing.lg)
            }
            .sensoryFeedback(.impact(weight: .light), trigger: call.phase)
        }
    }

    private func header(_ call: ActiveCall) -> some View {
        VStack(spacing: Spacing.xs) {
            Text(call.title)
                .font(.largeTitle.bold())
                .foregroundStyle(.textPrimary)
            TimelineView(.periodic(from: call.startedAt, by: 1)) { context in
                Text(statusText(call, now: context.date))
                    .font(.headline.monospacedDigit())
                    .foregroundStyle(.textSecondary)
                    .contentTransition(.numericText())
            }
        }
        .padding(.top, Spacing.xxl)
        .accessibilityElement(children: .combine)
    }

    private func statusText(_ call: ActiveCall, now: Date) -> String {
        switch call.phase {
        case .connecting: "Connecting…"
        case .speaking: "Speaking • \(DurationText.clock(now.timeIntervalSince(call.startedAt)))"
        case .listening: "Listening • \(DurationText.clock(now.timeIntervalSince(call.startedAt)))"
        }
    }

    private func transcript(_ call: ActiveCall) -> some View {
        VStack(spacing: Spacing.sm) {
            ForEach(call.transcript.suffix(2)) { line in
                Text(line.text)
                    .font(line.speaker == .agent ? .title3.weight(.medium) : .body)
                    .foregroundStyle(line.speaker == .agent ? Color.textPrimary : Color.textSecondary)
                    .multilineTextAlignment(.center)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .frame(minHeight: 60)
        .animation(.default, value: call.transcript)
    }

    private var controls: some View {
        GlassEffectContainer(spacing: Spacing.xxl) {
            HStack(spacing: Spacing.xxl) {
                CallControl(title: store.isMuted ? "Unmute" : "Mute", systemImage: store.isMuted ? "mic.slash.fill" : "mic.fill", isOn: store.isMuted) {
                    store.setMuted(!store.isMuted)
                }
                VStack(spacing: Spacing.sm) {
                    // The system picker lists every available output: iPhone, Speaker, AirPods,
                    // other Bluetooth headsets and the car.
                    RoutePicker()
                        .frame(width: 72, height: 72)
                        .glassEffect(.regular, in: .circle)
                        .accessibilityLabel("Audio output")
                    Text("Audio")
                        .font(.footnote)
                        .foregroundStyle(.textSecondary)
                        .accessibilityHidden(true)
                }
                VStack(spacing: Spacing.sm) {
                    Button {
                        store.endCall()
                    } label: {
                        Image(systemName: "phone.down.fill")
                            .font(.title2.weight(.semibold))
                            .frame(width: 72, height: 72)
                    }
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.circle)
                    .tint(.red)
                    .accessibilityLabel("End Call")
                    Text("End")
                        .font(.footnote)
                        .foregroundStyle(.textSecondary)
                        .accessibilityHidden(true)
                }
            }
        }
        .padding(.bottom, Spacing.lg)
    }
}

private struct RoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.tintColor = UIColor(Color.textPrimary)
        view.activeTintColor = UIColor(Color.gold)
        view.prioritizesVideoDevices = false
        return view
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}

private struct CallControl: View {
    let title: String
    let systemImage: String
    let isOn: Bool
    let action: () -> Void

    var body: some View {
        VStack(spacing: Spacing.sm) {
            Button(action: action) {
                Image(systemName: systemImage)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(isOn ? Color.onGold : Color.textPrimary)
                    .frame(width: 72, height: 72)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .tint(isOn ? .gold : nil)
            .accessibilityLabel(title)
            .accessibilityAddTraits(isOn ? .isSelected : [])
            Text(title)
                .font(.footnote)
                .foregroundStyle(.textSecondary)
                .accessibilityHidden(true)
        }
    }
}

private struct CallOrb: View {
    let phase: CallPhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        ZStack {
            ForEach(0..<3, id: \.self) { ring in
                Circle()
                    .stroke(Color.gold.opacity(0.18 - Double(ring) * 0.05), lineWidth: 1)
                    .frame(width: 180 + CGFloat(ring) * 50, height: 180 + CGFloat(ring) * 50)
                    .scaleEffect(pulse && phase != .connecting ? 1.06 : 1)
            }
            Circle()
                .fill(
                    RadialGradient(
                        colors: [.goldHighlight.opacity(0.9), .gold.opacity(0.55), .goldDeep.opacity(0.0)],
                        center: .center,
                        startRadius: 0,
                        endRadius: 110
                    )
                )
                .frame(width: 220, height: 220)
                .blur(radius: 20)
                .opacity(phase == .speaking ? 1 : 0.6)
            Circle()
                .fill(Color.bg)
                .frame(width: 132, height: 132)
                .overlay {
                    Circle().strokeBorder(Color.goldMid.opacity(0.6), lineWidth: 1)
                }
            HelixMark(size: 72)
        }
        .animation(.easeInOut(duration: 0.6), value: phase)
        .accessibilityHidden(true)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }
}

#Preview {
    let store = HelixStore()
    store.startCall(.claude)
    return CallView()
        .environment(store)
}
