import Foundation

/// Mirrors the server's `GatewayEvent` discriminated union (pc-gateway/src/types.ts). Only the
/// cases HelixStore currently acts on (chat/sessions) are modeled with their payload; everything
/// else decodes to `.unknown(type:)` so a future event type, or one this pass hasn't wired up
/// yet (calls, watchers, approvals, PC-voice audio), never breaks the socket - it is just
/// ignored until something needs it.
enum GatewayEvent: Decodable {
    case hello(deviceId: String?)
    case messageCreated(AgentMessageDTO)
    case agentOutputDelta(sessionId: String, turnId: String, text: String)
    case agentOutputFinal(sessionId: String, turnId: String, text: String, messageId: String, spoken: String?)
    case agentTool(sessionId: String, turnId: String, name: String)
    /// One complete, speech-ready sentence of a reply, voice turns only - speak these in order
    /// as they arrive instead of waiting for the whole reply. `seq` counts from 0 within the turn.
    case agentSpeech(sessionId: String, turnId: String, seq: Int, text: String, engine: String?)
    /// PC voice: one sentence of raw mono PCM (`pcm_s16le`), play in order. `engine == "pc"` on the
    /// matching `agentSpeech` means this audio is coming and Apple's voice must stay quiet.
    case agentAudio(sessionId: String, turnId: String, seq: Int, sampleRate: Int, pcm: Data)
    case agentAudioEnd(sessionId: String, turnId: String)
    /// The PC voice could not speak this turn: say the `agentSpeech` text with Apple's voice.
    case agentAudioUnavailable(sessionId: String, turnId: String)
    /// A spoken turn has produced all its sentences. `cancelled`: it was interrupted (barge-in
    /// or route.interrupt) - drop anything still queued rather than speaking it.
    case agentSpeechEnd(sessionId: String, turnId: String, cancelled: Bool)
    case agentSessionChanged(AgentSessionInfoDTO)
    case callRinging(CallDTO)
    case callAnswered(CallDTO)
    case callEnded(CallDTO)
    /// The user said goodbye (or the agent ended the call): speak the next reply, then hang up.
    case callHangup(CallDTO)
    case approvalRequested(ApprovalDTO)
    case approvalResolved(ApprovalDTO)
    case routeCreated(routeId: String, routerSessionId: String)
    case routeHandoff(routeId: String, fromSessionId: String, toSessionId: String, toTitle: String, mode: String)
    case sendAccepted(clientId: String?, routeId: String?, sessionId: String, messageId: String, turnId: String)
    case error(status: Int?, message: String, clientId: String?)
    case pong
    case unknown(type: String)

    private enum CodingKeys: String, CodingKey {
        case type, deviceId, sessionId, turnId, text, messageId, message, spoken, name, routeId, routerSessionId,
            fromSessionId, toSessionId, toTitle, mode, clientId, status, error, session, approval,
            seq, cancelled, call, engine, sampleRate, data
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "hello":
            self = .hello(deviceId: try container.decodeIfPresent(String.self, forKey: .deviceId))

        case "message.created":
            self = .messageCreated(try container.decode(AgentMessageDTO.self, forKey: .message))

        case "agent.output.delta":
            self = .agentOutputDelta(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                turnId: try container.decode(String.self, forKey: .turnId),
                text: try container.decode(String.self, forKey: .text)
            )

        case "agent.output.final":
            self = .agentOutputFinal(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                turnId: try container.decode(String.self, forKey: .turnId),
                text: try container.decode(String.self, forKey: .text),
                messageId: try container.decode(String.self, forKey: .messageId),
                spoken: try container.decodeIfPresent(String.self, forKey: .spoken)
            )

        case "agent.tool":
            self = .agentTool(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                turnId: try container.decode(String.self, forKey: .turnId),
                name: try container.decode(String.self, forKey: .name)
            )

        case "agent.speech":
            self = .agentSpeech(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                turnId: try container.decode(String.self, forKey: .turnId),
                seq: try container.decode(Int.self, forKey: .seq),
                text: try container.decode(String.self, forKey: .text),
                engine: try container.decodeIfPresent(String.self, forKey: .engine)
            )

        case "agent.audio":
            let base64 = try container.decode(String.self, forKey: .data)
            self = .agentAudio(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                turnId: try container.decode(String.self, forKey: .turnId),
                seq: try container.decode(Int.self, forKey: .seq),
                sampleRate: try container.decode(Int.self, forKey: .sampleRate),
                pcm: Data(base64Encoded: base64) ?? Data()
            )

        case "agent.audio.end":
            self = .agentAudioEnd(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                turnId: try container.decode(String.self, forKey: .turnId)
            )

        case "agent.audio.unavailable":
            self = .agentAudioUnavailable(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                turnId: try container.decode(String.self, forKey: .turnId)
            )

        case "agent.speech.end":
            self = .agentSpeechEnd(
                sessionId: try container.decode(String.self, forKey: .sessionId),
                turnId: try container.decode(String.self, forKey: .turnId),
                cancelled: try container.decode(Bool.self, forKey: .cancelled)
            )

        case "agent.session.changed":
            self = .agentSessionChanged(try container.decode(AgentSessionInfoDTO.self, forKey: .session))

        case "call.ringing":
            self = .callRinging(try container.decode(CallDTO.self, forKey: .call))

        case "call.answered":
            self = .callAnswered(try container.decode(CallDTO.self, forKey: .call))

        case "call.ended":
            self = .callEnded(try container.decode(CallDTO.self, forKey: .call))

        case "call.hangup":
            self = .callHangup(try container.decode(CallDTO.self, forKey: .call))

        case "approval.requested":
            self = .approvalRequested(try container.decode(ApprovalDTO.self, forKey: .approval))

        case "approval.resolved":
            self = .approvalResolved(try container.decode(ApprovalDTO.self, forKey: .approval))

        case "route.created":
            self = .routeCreated(
                routeId: try container.decode(String.self, forKey: .routeId),
                routerSessionId: try container.decode(String.self, forKey: .routerSessionId)
            )

        case "route.handoff":
            self = .routeHandoff(
                routeId: try container.decode(String.self, forKey: .routeId),
                fromSessionId: try container.decode(String.self, forKey: .fromSessionId),
                toSessionId: try container.decode(String.self, forKey: .toSessionId),
                toTitle: try container.decode(String.self, forKey: .toTitle),
                mode: try container.decode(String.self, forKey: .mode)
            )

        case "send.accepted":
            self = .sendAccepted(
                clientId: try container.decodeIfPresent(String.self, forKey: .clientId),
                routeId: try container.decodeIfPresent(String.self, forKey: .routeId),
                sessionId: try container.decode(String.self, forKey: .sessionId),
                messageId: try container.decode(String.self, forKey: .messageId),
                turnId: try container.decode(String.self, forKey: .turnId)
            )

        case "error":
            self = .error(
                status: try container.decodeIfPresent(Int.self, forKey: .status),
                message: try container.decode(String.self, forKey: .error),
                clientId: try container.decodeIfPresent(String.self, forKey: .clientId)
            )

        case "pong":
            self = .pong

        default:
            self = .unknown(type: type)
        }
    }
}
