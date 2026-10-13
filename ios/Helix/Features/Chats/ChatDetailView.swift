import SwiftUI

struct ChatDetailView: View {
    let conversationID: String

    @Environment(HelixStore.self) private var store
    @State private var draft = ""
    @FocusState private var composerFocused: Bool

    var body: some View {
        if let conversation = store.conversation(id: conversationID) {
            content(conversation)
        } else {
            ContentUnavailableView("Chat Not Found", systemImage: "bubble.left", description: Text("This conversation is no longer on the PC."))
                .background(Color.bg.ignoresSafeArea())
        }
    }

    private func content(_ conversation: Conversation) -> some View {
        let isTyping = store.typingConversationIDs.contains(conversation.id)

        return ScrollView {
            LazyVStack(spacing: Spacing.md) {
                if store.hasMoreHistory.contains(conversation.id) {
                    Button("Load Earlier Messages") {
                        Task { await store.loadConversation(conversation.id, older: true) }
                    }
                    .frame(minHeight: 44)
                    .disabled(store.loadingConversationIDs.contains(conversation.id))
                }
                if store.loadingConversationIDs.contains(conversation.id) {
                    ProgressView("Loading history…")
                }
                ForEach(conversation.messages) { message in
                    MessageView(message: message)
                }
                if let text = store.streamingReplies[conversation.id], !text.isEmpty {
                    MessageView(message: ChatMessage(id: "stream", sender: .agent, text: text, createdAt: .now))
                        .accessibilityLabel("Reply in progress: \(text)")
                } else if isTyping {
                    TypingIndicator()
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, Spacing.lg)
            .padding(.vertical, Spacing.md)
            .animation(.default, value: conversation.messages.count)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .background(Color.bg.ignoresSafeArea())
        .navigationTitle(conversation.title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: conversation.id) {
            // "Start Here" is always a fresh conversation on screen, every time it's opened -
            // the underlying route is still reused in the background (so a new one isn't
            // spawned per visit), but old scrollback from a previous visit, or from another
            // device, never reappears. A real agent session (not a front door) is the opposite:
            // its whole real transcript is the point, so it loads normally.
            if conversation.frontDoor != nil {
                store.resetFrontDoorConversation(conversation.id)
            } else {
                await store.loadConversation(conversation.id)
            }
            // HTTP recovery also catches replies produced while the app was backgrounded -
            // still useful for a front-door chat mid-conversation, just filtered to this visit.
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(4)) } catch { return }
                if store.typingConversationIDs.contains(conversation.id) {
                    await store.loadConversation(conversation.id)
                }
            }
        }
        .refreshable { await store.loadConversation(conversation.id) }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
            if let notice = store.chatNotices[conversation.id] {
                EventLine(text: notice, systemImage: "arrow.triangle.branch")
                    .padding(.horizontal, Spacing.lg)
            }
            if let error = store.chatErrors[conversation.id] {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Refresh Chat") { Task { await store.loadConversation(conversation.id) } }
                        .frame(minHeight: 44)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Spacing.md)
                .helixCard()
                .padding(.horizontal, Spacing.lg)
            }
            Composer(
                draft: $draft,
                placeholder: "Message \(conversation.frontDoor?.displayName ?? conversation.title)",
                enabled: store.canSend(to: conversation.id),
                sending: store.sendingConversationIDs.contains(conversation.id),
                isFocused: $composerFocused
            ) {
                // Clear immediately on tap (like Claude/ChatGPT/iMessage - don't wait on the
                // network round trip) and put the text back only if the send actually failed,
                // so nothing is lost. Comparing draft == submitted after the fact was fragile:
                // a vertical-axis TextField can sneak a trailing newline into `draft` between
                // reading it and the Task resuming, which made the field never clear.
                let submitted = draft
                draft = ""
                Task {
                    if !(await store.send(submitted, to: conversation.id)) {
                        draft = submitted
                    }
                }
            }
            }
            .background(Color.bg)
        }
        .alert(
            "Large Session",
            isPresented: Binding(
                get: { store.heavySessionPrompt?.conversationID == conversation.id },
                set: { if !$0 { store.dismissHeavySessionPrompt() } }
            ),
            presenting: store.heavySessionPrompt
        ) { prompt in
            if conversation.frontDoor != nil {
                Button("Start Fresh") { Task { await store.startFreshAndSend() } }
            }
            Button("Continue Anyway") { Task { await store.confirmHeavySend() } }
            Button("Cancel", role: .cancel) {
                draft = prompt.text
                store.dismissHeavySessionPrompt()
            }
        } message: { prompt in
            Text("This session is about \(prompt.contextTokens / 1000)k tokens. Continuing will use a lot of your usage.")
        }
    }
}

private struct MessageView: View {
    let message: ChatMessage

    var body: some View {
        switch message.sender {
        case .user where message.isWatcherEvent:
            EventLine(text: watcherText, systemImage: "bell.badge")
        case .user:
            bubble(alignment: .trailing, fill: .surfaceWarm, border: .goldMid.opacity(0.45))
        case .agent:
            bubble(alignment: .leading, fill: .surface, border: .borderWarm)
        case .system:
            EventLine(text: message.text, systemImage: "arrow.triangle.branch")
        }
    }

    private var watcherText: String {
        message.text
            .replacingOccurrences(of: "[Helix watcher]", with: "")
            .trimmingCharacters(in: .whitespaces)
    }

    private func bubble(alignment: HorizontalAlignment, fill: Color, border: Color) -> some View {
        MessageContent(text: message.text)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .helixCard(fill: fill, border: border, radius: 20)
            .frame(maxWidth: 520, alignment: alignment == .leading ? .leading : .trailing)
            .frame(maxWidth: .infinity, alignment: alignment == .leading ? .leading : .trailing)
            .padding(alignment == .leading ? .trailing : .leading, 40)
    }
}

/// Renders a message's text like Claude/ChatGPT do: fenced ```code``` blocks become a distinct
/// monospaced card (own background, horizontally scrollable, optional language label), plain
/// text in between renders through SwiftUI's inline Markdown (bold/italic/inline `code`/links).
/// A streaming reply can end mid-fence - that trailing fence is shown as an open code block
/// rather than as a stray "```" in the text, and closes normally once the rest arrives.
private struct MessageContent: View {
    let text: String

    private struct Segment: Identifiable {
        let id = UUID()
        var isCode: Bool
        var language: String?
        var text: String
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(segments) { segment in
                if segment.isCode {
                    CodeBlockView(language: segment.language, code: segment.text)
                } else if !segment.text.isEmpty {
                    Text(Self.markdown(segment.text))
                        .font(.body)
                        .foregroundStyle(.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .textSelection(.enabled)
    }

    private var segments: [Segment] {
        var result: [Segment] = []
        var rest = Substring(text)
        while let fence = rest.range(of: "```") {
            let before = rest[rest.startIndex..<fence.lowerBound]
            if !before.isEmpty { result.append(Segment(isCode: false, language: nil, text: String(before))) }

            let afterFence = rest[fence.upperBound...]
            let firstLineEnd = afterFence.firstIndex(of: "\n") ?? afterFence.endIndex
            let language = afterFence[afterFence.startIndex..<firstLineEnd]
                .trimmingCharacters(in: .whitespaces)
            let body = firstLineEnd == afterFence.endIndex
                ? Substring("") : afterFence[afterFence.index(after: firstLineEnd)...]

            if let close = body.range(of: "```") {
                result.append(Segment(isCode: true, language: language.isEmpty ? nil : language, text: String(body[body.startIndex..<close.lowerBound])))
                rest = body[close.upperBound...]
            } else {
                // Unterminated: still streaming. Show what has arrived as an open code block.
                result.append(Segment(isCode: true, language: language.isEmpty ? nil : language, text: String(body)))
                rest = Substring("")
            }
        }
        if !rest.isEmpty { result.append(Segment(isCode: false, language: nil, text: String(rest))) }
        return result
    }

    private static func markdown(_ string: String) -> AttributedString {
        var options = AttributedString.MarkdownParsingOptions()
        options.interpretedSyntax = .inlineOnlyPreservingWhitespace
        return (try? AttributedString(markdown: string, options: options)) ?? AttributedString(string)
    }
}

private struct CodeBlockView: View {
    let language: String?
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let language {
                Text(language.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.textSecondary)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code.trimmingCharacters(in: .newlines))
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(.textPrimary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, language == nil ? 10 : 6)
            }
        }
        .padding(.bottom, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.bg, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.borderWarm, lineWidth: 1))
    }
}

private struct EventLine: View {
    let text: String
    let systemImage: String

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.footnote)
            .foregroundStyle(.textSecondary)
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, 6)
            .background(Color.surface, in: .capsule)
            .frame(maxWidth: .infinity)
    }
}

private struct TypingIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Color.textSecondary)
                    .frame(width: 7, height: 7)
                    .phaseAnimator(reduceMotion ? [1.0] : [0.35, 1.0]) { dot, phase in
                        dot.opacity(phase)
                    } animation: { _ in
                        .easeInOut(duration: 0.5).delay(Double(index) * 0.15)
                    }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 14)
        .helixCard(radius: 20)
        .accessibilityLabel("Typing")
    }
}

private struct Composer: View {
    @Binding var draft: String
    let placeholder: String
    let enabled: Bool
    let sending: Bool
    var isFocused: FocusState<Bool>.Binding
    let onSend: () -> Void

    private var canSend: Bool { enabled && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: Spacing.sm) {
            TextField(placeholder, text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .focused(isFocused)
                .submitLabel(.send)
                .onSubmit { if canSend { onSend() } }
                .padding(.horizontal, Spacing.lg)
                .padding(.vertical, 11)
                .glassEffect(.regular, in: .rect(cornerRadius: 22))

            Button(action: onSend) {
                Group {
                    if sending { ProgressView() } else { Image(systemName: "arrow.up") }
                }
                    .font(.body.weight(.bold))
                    .foregroundStyle(canSend ? Color.onGold : Color.textSecondary)
                    .frame(width: 44, height: 44)
                    .background(canSend ? Color.gold : Color.surfaceSecondary, in: .circle)
            }
            .disabled(!canSend)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, Spacing.lg)
        .padding(.vertical, Spacing.sm)
    }
}

#Preview {
    NavigationStack {
        ChatDetailView(conversationID: "training")
    }
    .environment(HelixStore())
}
