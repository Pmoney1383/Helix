import SwiftUI

enum HomeRoute: Hashable {
    case status
    case approvals
    case conversation(String)
}

struct HomeView: View {
    @Environment(HelixStore.self) private var store
    @State private var path: [HomeRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    HomeHeader(isOnline: store.gateway.isOnline)

                    if let update = store.heroUpdate {
                        HeroCard(
                            update: update,
                            onOpen: { path.append(update.conversationID.map(HomeRoute.conversation) ?? .status) },
                            onCall: { store.startCall(.claude) },
                            onHide: { withAnimation { store.heroUpdate = nil } }
                        )
                    }

                    AdaptiveRow {
                        AssistantCallCard(door: .claude) { store.startCall(.claude) }
                        AssistantCallCard(door: .codex) { store.startCall(.codex) }
                    }

                    AdaptiveRow {
                        NavigationLink(value: HomeRoute.status) {
                            ActionTile(title: "Check Status", subtitle: "See system health", systemImage: "chart.bar.fill")
                        }
                        NavigationLink(value: HomeRoute.approvals) {
                            ActionTile(
                                title: "Approvals",
                                subtitle: "Review pending items",
                                systemImage: "checkmark.shield",
                                badge: store.pendingApprovals.count
                            )
                        }
                    }
                    .buttonStyle(.pressable)

                    RecentSection(conversations: Array(store.recentConversations.prefix(2))) {
                        store.selectedTab = .chats
                    }
                    .padding(.top, Spacing.sm)
                }
                .padding(.horizontal, Spacing.screen)
                .padding(.bottom, Spacing.xxl)
            }
            .scrollIndicators(.hidden)
            .background(Color.bg.ignoresSafeArea())
            .statusBarFade()
            .toolbarVisibility(.hidden, for: .navigationBar)
            .navigationTitle("Home")
            .onChange(of: store.pendingHomeRoute, initial: true) { _, route in
                guard let route else { return }
                path = [route]
                store.pendingHomeRoute = nil
            }
            .navigationDestination(for: HomeRoute.self) { route in
                switch route {
                case .status: StatusView()
                case .approvals: ApprovalsView()
                case .conversation(let id): ChatDetailView(conversationID: id)
                }
            }
        }
    }
}

private struct HomeHeader: View {
    let isOnline: Bool
    @ScaledMetric(relativeTo: .largeTitle) private var markSize: CGFloat = 50

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: Spacing.md) {
                brand
                Spacer(minLength: Spacing.sm)
                StatusPill(isOnline: isOnline)
            }
            VStack(alignment: .leading, spacing: Spacing.md) {
                brand
                StatusPill(isOnline: isOnline)
            }
        }
        .padding(.top, Spacing.sm)
    }

    private var brand: some View {
        HStack(spacing: Spacing.md) {
            HelixMark(size: markSize)
            VStack(alignment: .leading, spacing: 0) {
                Text("Helix")
                    .font(.largeTitle.bold())
                    .foregroundStyle(.textPrimary)
                    .accessibilityAddTraits(.isHeader)
                Text("Your AI, under control.")
                    .font(.subheadline)
                    .foregroundStyle(.textMuted)
            }
        }
    }
}

private struct RecentSection: View {
    let conversations: [Conversation]
    let onSeeAll: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            SectionHeader(title: "Recent") {
                Button(action: onSeeAll) {
                    HStack(spacing: Spacing.xs) {
                        Text("See all")
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.bold))
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.gold)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                }
                .accessibilityLabel("See All Chats")
            }

            if conversations.isEmpty {
                Text("Chats with Claude and Astra show up here.")
                    .font(.subheadline)
                    .foregroundStyle(.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Spacing.lg)
                    .helixCard()
            } else {
                VStack(spacing: 0) {
                    ForEach(conversations) { conversation in
                        NavigationLink(value: HomeRoute.conversation(conversation.id)) {
                            RecentRow(conversation: conversation)
                        }
                        .buttonStyle(.plain)

                        if conversation.id != conversations.last?.id {
                            Divider()
                                .overlay(Color.borderWarm.opacity(0.6))
                        }
                    }
                }
                .padding(.horizontal, Spacing.lg)
                .padding(.vertical, Spacing.xs)
                .helixCard(radius: Radius.tile)
            }
        }
    }
}

#Preview {
    HomeView()
        .environment(HelixStore())
}
