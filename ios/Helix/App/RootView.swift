import SwiftUI

struct RootView: View {
    @Environment(HelixStore.self) private var store

    var body: some View {
        @Bindable var store = store

        TabView(selection: $store.selectedTab) {
            Tab("Home", systemImage: "house", value: AppTab.home) {
                HomeView()
            }
            Tab("Chats", systemImage: "bubble.left", value: AppTab.chats) {
                ChatsView()
            }
            Tab("Calls", systemImage: "phone", value: AppTab.calls) {
                CallsView()
            }
            Tab("Settings", systemImage: "gearshape", value: AppTab.settings) {
                SettingsView()
            }
        }
        .tint(.goldActive)
        .fullScreenCover(isPresented: Binding(
            get: { store.activeCall != nil && !store.callScreenHidden },
            set: { if !$0 { store.callScreenHidden = true } }
        )) {
            CallView()
        }
        .overlay(alignment: .top) {
            if let call = store.activeCall, store.callScreenHidden {
                Button { store.callScreenHidden = false } label: {
                    HStack(spacing: Spacing.sm) {
                        Image(systemName: "phone.fill")
                        Text("On a call with \(call.title) · Tap to return")
                            .font(.footnote.weight(.semibold))
                    }
                    .foregroundStyle(Color.onGold)
                    .padding(.horizontal, Spacing.lg)
                    .padding(.vertical, Spacing.sm)
                    .background(Capsule().fill(Color.gold))
                }
                .padding(.top, Spacing.xs)
            }
        }
    }
}

#Preview {
    RootView()
        .environment(HelixStore())
}
