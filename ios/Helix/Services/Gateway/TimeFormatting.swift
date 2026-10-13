import Foundation

enum RelativeTime {
    /// "now", "8m ago", "2h 14m ago", "6h ago", "yesterday", "3d ago".
    static func short(from date: Date, to now: Date = .now) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        let minutes = seconds / 60
        let hours = minutes / 60
        switch seconds {
        case ..<60:
            return "now"
        case ..<3_600:
            return "\(minutes)m ago"
        case ..<(3 * 3_600):
            let remainder = minutes % 60
            return remainder == 0 ? "\(hours)h ago" : "\(hours)h \(remainder)m ago"
        case ..<86_400:
            return "\(hours)h ago"
        case ..<(2 * 86_400):
            return "yesterday"
        default:
            return "\(hours / 24)d ago"
        }
    }
}

enum DurationText {
    /// "1h 24m", "12m", "45s". Negative intervals read as "0m".
    static func short(_ interval: TimeInterval) -> String {
        let seconds = max(0, Int(interval.rounded()))
        let hours = seconds / 3_600
        let minutes = (seconds % 3_600) / 60
        if hours > 0 { return "\(hours)h \(minutes)m" }
        if minutes > 0 { return "\(minutes)m" }
        return seconds > 0 ? "\(seconds)s" : "0m"
    }

    /// "4:12", "1:02:09" for call timers.
    static func clock(_ interval: TimeInterval) -> String {
        let seconds = max(0, Int(interval))
        let hours = seconds / 3_600
        let minutes = (seconds % 3_600) / 60
        let secs = seconds % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, secs)
            : String(format: "%d:%02d", minutes, secs)
    }
}
