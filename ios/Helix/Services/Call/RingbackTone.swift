import AVFoundation

/// The "brrring ... brrring" played after the user calls Helix, so the instant gateway answer
/// still feels like dialling someone. Two summed sines (440 + 480 Hz), 1.0 s on, 0.6 s off,
/// cut to exactly `durationMs` with a short fade so it never clicks.
enum RingbackTone {
    static func buffer(durationMs: Int, sampleRate: Double = 44_100) -> AVAudioPCMBuffer? {
        let total = Int(Double(durationMs) / 1000 * sampleRate)
        guard total > 0,
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(total)),
              let samples = buffer.floatChannelData?[0] else { return nil }
        buffer.frameLength = AVAudioFrameCount(total)
        let on = 1.0, period = 1.6, fade = 0.02
        for i in 0..<total {
            let t = Double(i) / sampleRate
            let phase = t.truncatingRemainder(dividingBy: period)
            var gain = 0.0
            if phase < on {
                gain = min(1, phase / fade, (on - phase) / fade)
            }
            let tail = min(1, (Double(total - i) / sampleRate) / fade)
            let tone = sin(2 * .pi * 440 * t) + sin(2 * .pi * 480 * t)
            samples[i] = Float(0.18 * gain * tail * tone)
        }
        return buffer
    }
}
