import SwiftUI

struct ChatsView: View {
    @Environment(HelixStore.self) private var store
    @State private var query = ""
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if store.isPaired {
                    if store.isLoadingSessions { ProgressView("Loading sessions…") }
                    if let error = store.sessionsError {
                        Section {
                            Text(error).font(.subheadline)
                            Button("Retry") { Task { await store.syncAgentSessions() } }
                        }
                    }

                    Section(query.isEmpty ? "Chats" : "Results") {
                        ForEach(filtered) { conversation in
                            row(conversation)
                        }
                    }
                } else {
                    ContentUnavailableView {
                        Label("Pair Your PC", systemImage: "desktopcomputer")
                    } description: {
                        Text("Pair in Settings to view and continue real Claude and Codex sessions.")
                    } actions: {
                        Button("Open Settings") { store.selectedTab = .settings }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color.bg.ignoresSafeArea())
            .navigationTitle("Chats")
            .searchable(text: $query, prompt: "Search chats")
            .refreshable { await store.syncAgentSessions() }
            .overlay {
                if store.isPaired && !query.isEmpty && filtered.isEmpty {
                    ContentUnavailableView.search(text: query)
                } else if store.isPaired && query.isEmpty && filtered.isEmpty && !store.isLoadingSessions {
                    ContentUnavailableView {
                        Label("No Chats Yet", systemImage: "bubble.left.and.bubble.right")
                    } description: {
                        Text("Tap \(Image(systemName: "plus.circle.fill")) to start a new conversation with Claude or Astra.")
                    }
                }
            }
            .navigationDestination(for: String.self) { id in
                ChatDetailView(conversationID: id)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    newChatMenu
                }
            }
        }
    }

    /// "New Claude" / "New Astra": the same front-door conversation as before (reused in the
    /// background so the PC side doesn't accumulate a new router session per tap - see
    /// HelixStore.ensureFrontDoorRoutes), always opening fresh (resetFrontDoorConversation).
    /// Replaces the old always-visible "Start Here" rows with a single compose-style entry
    /// point, so the list itself only ever shows conversations that are actually in use.
    private var newChatMenu: some View {
        Menu {
            ForEach(FrontDoor.allCases) { door in
                Button {
                    guard let id = store.frontDoorConversations.first(where: { $0.frontDoor == door })?.id else { return }
                    path.append(id)
                } label: {
                    Label {
                        Text("New \(door.displayName)")
                    } icon: {
                        BrandLogo(name: door.logo)
                    }
                }
            }
        } label: {
            Image(systemName: "plus.circle.fill")
                .font(.title2)
                .foregroundStyle(.goldActive)
        }
        .disabled(!store.isPaired)
        .accessibilityLabel("New Chat")
    }

    private var filtered: [Conversation] {
        let source = query.isEmpty ? store.visibleConversations : store.recentConversations
        guard !query.isEmpty else { return source }
        return source.filter {
            $0.title.localizedCaseInsensitiveContains(query) || $0.preview.localizedCaseInsensitiveContains(query)
        }
    }

    private func row(_ conversation: Conversation) -> some View {
        NavigationLink(value: conversation.id) {
            ChatListRow(conversation: conversation, isTyping: store.typingConversationIDs.contains(conversation.id))
        }
        .listRowBackground(Color.surface)
        .listRowSeparatorTint(.borderWarm)
    }
}

private struct ChatListRow: View {
    let conversation: Conversation
    let isTyping: Bool

    var body: some View {
        HStack(spacing: Spacing.md) {
            IconTile(icon: conversation.icon)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(conversation.title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: Spacing.sm)
                    TimelineView(.periodic(from: .now, by: 60)) { context in
                        Text(RelativeTime.short(from: conversation.lastActivityAt, to: context.date))
                            .font(.footnote)
                            .foregroundStyle(.textSecondary)
                    }
                }
                Text(isTyping ? "Typing…" : conversation.preview)
                    .font(.subheadline)
                    .foregroundStyle(isTyping ? Color.goldText : Color.textSecondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, Spacing.xs)
    }
}

#Preview {
    ChatsView()
        .environment(HelixStore())
}
