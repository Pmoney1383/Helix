import Testing
import Foundation
import AVFoundation
@testable import Helix

struct RingbackAndHangupTests {
    @Test func ringbackBufferMatchesRequestedDuration() throws {
        let buffer = try #require(RingbackTone.buffer(durationMs: 2000))
        #expect(buffer.frameLength == 88_200)
        let samples = try #require(buffer.floatChannelData?[0])
        #expect(samples[Int(buffer.frameLength) - 1] == 0 || abs(samples[Int(buffer.frameLength) - 1]) < 0.01)
    }

    @Test func callHangupEventDecodes() throws {
        let json = """
        {"type":"call.hangup","afterSpeech":true,"call":{"id":"c1","direction":"outgoing","status":"answered","severity":"info","title":"Claude","summary":"","script":"","expects":"conversation","ringbackMs":1800,"createdAt":"2026-10-08T10:00:00.000Z"}}
        """
        let event = try JSONDecoder.gateway.decode(GatewayEvent.self, from: Data(json.utf8))
        guard case let .callHangup(call) = event else { Issue.record("not a hangup"); return }
        #expect(call.id == "c1")
        #expect(call.ringbackMs == 1800)
    }

    @Test func pcVoiceEventsDecode() throws {
        let speech = #"{"type":"agent.speech","sessionId":"s","turnId":"t","seq":0,"text":"Hi.","engine":"pc","style":"normal"}"#
        guard case let .agentSpeech(_, _, seq, text, engine) = try JSONDecoder.gateway.decode(GatewayEvent.self, from: Data(speech.utf8)) else {
            Issue.record("not speech"); return
        }
        #expect(seq == 0 && text == "Hi." && engine == "pc")

        let audio = #"{"type":"agent.audio","sessionId":"s","turnId":"t","seq":0,"sampleRate":24000,"format":"pcm_s16le","data":"AAAB/w=="}"#
        guard case let .agentAudio(_, _, _, rate, pcm) = try JSONDecoder.gateway.decode(GatewayEvent.self, from: Data(audio.utf8)) else {
            Issue.record("not audio"); return
        }
        #expect(rate == 24000 && pcm.count == 4)

        let end = #"{"type":"agent.audio.end","sessionId":"s","turnId":"t"}"#
        guard case .agentAudioEnd = try JSONDecoder.gateway.decode(GatewayEvent.self, from: Data(end.utf8)) else {
            Issue.record("not end"); return
        }
    }
}
