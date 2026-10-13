import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(HelixStore.self) private var store
    @State private var isPairing = false

    private var signingLabel: String {
        guard let status = store.signingStatus else { return store.signingProblem == nil ? "Checking…" : "Off" }
        return status.enrolled ? "On" : "Off"
    }

    var body: some View {
        @Bindable var store = store

        NavigationStack {
            Form {
                Section {
                    HStack(spacing: Spacing.md) {
                        HelixMark(size: 36)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(store.gateway.hostName)
                                .font(.body.weight(.semibold))
                            Text(store.gateway.address)
                                .font(.footnote)
                                .foregroundStyle(.textSecondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer(minLength: Spacing.sm)
                        Text(store.gateway.isOnline ? "Online" : "Offline")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(store.gateway.isOnline ? Color.online : Color.textSecondary)
                    }
                    .padding(.vertical, Spacing.xs)
                    .accessibilityElement(children: .combine)

                    HStack {
                        Text("Request signing")
                        Spacer()
                        Text(signingLabel)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(store.signingStatus?.enrolled == true ? Color.online : Color.textSecondary)
                    }
                    if let problem = store.signingProblem {
                        Text(problem).font(.footnote).foregroundStyle(.textSecondary)
                    }

                    Button("Pair Again…") { isPairing = true }
                } header: {
                    Text("Gateway")
                }
                .listRowBackground(Color.surface)

                Section {
                    Picker("Alerts", selection: Binding(
                        get: { store.presence },
                        set: { store.setPresence($0) }
                    )) {
                        ForEach(PresenceMode.allCases) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                } header: {
                    Text("Phone Alerts")
                } footer: {
                    Text(store.presence.explanation)
                }

                Section {
                    Toggle("Personality", isOn: $store.persona.enabled)
                    Picker("Mode", selection: Binding(
                        get: { store.persona.mode },
                        set: { store.persona.apply($0) }
                    )) {
                        ForEach(PersonaMode.allCases) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                    .disabled(!store.persona.enabled)

                    Group {
                        PersonaSlider(title: "Teasing", value: $store.persona.teasing)
                        PersonaSlider(title: "Flirtiness", value: $store.persona.flirtiness)
                        PersonaSlider(title: "Sarcasm", value: $store.persona.sarcasm)
                        PersonaSlider(title: "Verbosity", value: $store.persona.verbosity)
                    }
                    .disabled(!store.persona.enabled)

                    NavigationLink {
                        PetNamesView(names: $store.persona.petNames)
                    } label: {
                        LabeledContent("Pet Names", value: "\(store.persona.petNames.count)")
                    }
                } header: {
                    Text("Voice Personality")
                } footer: {
                    Text("Personality only changes how replies sound. Urgent alerts and approvals are always plain and direct.")
                }
                .listRowBackground(Color.surface)

                Section {
                    VStack(alignment: .leading, spacing: Spacing.sm) {
                        Text("Speaking Rate")
                        Slider(value: $store.persona.speechRate, in: 0...1) {
                            Text("Speaking Rate")
                        } minimumValueLabel: {
                            Image(systemName: "tortoise.fill").accessibilityLabel("Slower")
                        } maximumValueLabel: {
                            Image(systemName: "hare.fill").accessibilityLabel("Faster")
                        }
                        .foregroundStyle(.textSecondary)
                    }
                    .padding(.vertical, Spacing.xs)
                    Toggle("Use PC Voice When Available", isOn: $store.persona.usePCVoice)
                } header: {
                    Text("Speech")
                } footer: {
                    Text("The PC voice needs the GPU. When it's busy, Helix falls back to the iPhone's voice.")
                }
                .listRowBackground(Color.surface)

                Section {
                    ForEach(FrontDoor.allCases) { door in
                        HStack {
                            Text("Call \(door.displayName)")
                            Spacer()
                            AddToSiriButton(door: door).frame(width: 150, height: 36)
                        }
                    }
                } header: {
                    Text("Siri")
                } footer: {
                    Text("Say \"Hey Siri, call Claude using Helix\", or add your own phrase here.")
                }
                .listRowBackground(Color.surface)

                Section("About") {
                    LabeledContent("Version", value: Bundle.main.versionString)
                }
                .listRowBackground(Color.surface)
            }
            .scrollContentBackground(.hidden)
            .background(Color.bg.ignoresSafeArea())
            .navigationTitle("Settings")
            .sheet(isPresented: $isPairing) {
                PairingView()
                    .presentationDetents([.medium])
            }
        }
    }
}

private struct PersonaSlider: View {
    let title: String
    @Binding var value: Double

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            LabeledContent(title) {
                Text(value, format: .percent.precision(.fractionLength(0)))
                    .monospacedDigit()
            }
            Slider(value: $value, in: 0...1) {
                Text(title)
            }
        }
        .padding(.vertical, Spacing.xs)
    }
}

private struct PetNamesView: View {
    @Binding var names: [String]
    @State private var newName = ""

    private var canAdd: Bool {
        let trimmed = newName.trimmingCharacters(in: .whitespaces)
        return (2...20).contains(trimmed.count) && trimmed.allSatisfy(\.isLetter) && names.count < 12
    }

    var body: some View {
        List {
            Section {
                ForEach(names, id: \.self) { name in
                    Text(name)
                }
                .onDelete { names.remove(atOffsets: $0) }
                .deleteDisabled(names.count <= 1)
            } footer: {
                Text("Flirty mode picks one of these now and then. Keep 1 to 12 names, letters only.")
            }
            .listRowBackground(Color.surface)

            Section {
                HStack {
                    TextField("Add a name", text: $newName)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit(add)
                    Button("Add", action: add)
                        .disabled(!canAdd)
                }
            }
            .listRowBackground(Color.surface)
        }
        .scrollContentBackground(.hidden)
        .background(Color.bg.ignoresSafeArea())
        .navigationTitle("Pet Names")
        .toolbar { EditButton() }
    }

    private func add() {
        guard canAdd else { return }
        names.append(newName.trimmingCharacters(in: .whitespaces))
        newName = ""
    }
}

private struct PairingView: View {
    @Environment(HelixStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var addressText = GatewaySession.defaultBaseURLString
    @State private var showAddressField = false
    @FocusState private var focused: Bool

    private var isCodeValid: Bool { code.trimmingCharacters(in: .whitespaces).count >= 4 }
    private var address: URL? { URL(string: addressText.trimmingCharacters(in: .whitespaces)) }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                Text("On the PC, run **npm run pair** in the gateway folder, then enter the code it shows.")
                    .font(.subheadline)
                    .foregroundStyle(.textSecondary)

                TextField("Pairing code", text: $code)
                    .font(.title2.monospaced())
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .focused($focused)
                    .disabled(store.isPairing)
                    .padding(Spacing.lg)
                    .helixCard(radius: 16)

                DisclosureGroup("Gateway Address", isExpanded: $showAddressField) {
                    TextField("https://your-pc.tailnet.ts.net", text: $addressText)
                        .font(.footnote.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .disabled(store.isPairing)
                        .padding(.top, Spacing.xs)
                }
                .font(.footnote)
                .tint(.textSecondary)

                if let message = store.pairingErrorMessage {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }

                Spacer()
            }
            .padding(Spacing.screen)
            .background(Color.bg.ignoresSafeArea())
            .navigationTitle("Pair with Your PC")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(store.isPairing)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if store.isPairing {
                        ProgressView()
                    } else {
                        Button("Pair") { Task { await pair() } }
                            .disabled(!isCodeValid || address == nil)
                    }
                }
            }
            .onAppear {
                focused = true
                addressText = store.gatewaySession.baseURL.absoluteString
            }
        }
        .interactiveDismissDisabled(store.isPairing)
    }

    private func pair() async {
        guard let address else { return }
        let deviceName = UIDevice.current.name
        await store.pair(code: code, deviceName: deviceName, gatewayAddress: address)
        if store.isPaired { dismiss() }
    }
}

private extension Bundle {
    var versionString: String {
        let version = infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }
}

#Preview {
    SettingsView()
        .environment(HelixStore())
}
