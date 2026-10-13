import SwiftUI
import Intents

@main
struct HelixApp: App {
    @UIApplicationDelegateAdaptor(HelixAppDelegate.self) private var appDelegate
    @State private var store = AppServices.store
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .onContinueUserActivity("INStartCallIntent") { activity in
                    guard let intent = activity.interaction?.intent as? INStartCallIntent else { return }
                    store.startCall(SiriCalls.door(for: intent))
                }
                .task {
                    SiriCalls.donate()
                    // Real gateway status replaces the sample-data default as soon as we know
                    // it, instead of showing "Online" before the first real check completes.
                    await store.refreshGatewayStatus()
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        Task { await store.refreshGatewayStatus() }
                        store.warmVoice()
                    }
                }
        }
    }
}
