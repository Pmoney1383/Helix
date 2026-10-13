import Foundation

/// `GET /v1/pc/status` -> `{ pc: getPcStatus(), gpu: getGpuStatus() }` (the same data the MCP
/// tools `get_pc_status` / `get_gpu_status` return). See pc-gateway/README.md.
struct PCStatusResponse: Decodable, Equatable {
    var pc: PC
    var gpu: GPU?

    struct PC: Decodable, Equatable {
        var hostname: String
        var uptimeHours: Double
        var cpu: CPU
        var memory: Memory
        var disks: [Disk]
    }

    struct CPU: Decodable, Equatable {
        var model: String?
        var cores: Int
        var usagePercent: Int?
    }

    struct Memory: Decodable, Equatable {
        var totalGB: Double
        var freeGB: Double
        var usedFraction: Double { totalGB > 0 ? max(0, min(1, 1 - freeGB / totalGB)) : 0 }
    }

    struct Disk: Decodable, Equatable, Identifiable {
        var drive: String
        var totalGB: Double
        var freeGB: Double
        var id: String { drive }
        var usedFraction: Double { totalGB > 0 ? max(0, min(1, 1 - freeGB / totalGB)) : 0 }
    }

    struct GPU: Decodable, Equatable {
        var available: Bool
        var error: String?
        var gpus: [Card]?
    }

    struct Card: Decodable, Equatable, Identifiable {
        var index: Int
        var name: String
        var utilizationPercent: Double
        var memoryUsedMB: Double
        var memoryTotalMB: Double
        var temperatureC: Double
        var powerW: Double
        var id: Int { index }
        var memoryFraction: Double { memoryTotalMB > 0 ? max(0, min(1, memoryUsedMB / memoryTotalMB)) : 0 }
    }
}

/// One entry of `GET /v1/watches` (types.ts `Watch`), only the fields the status screen shows.
struct WatchDTO: Decodable {
    var id: String
    var name: String
    var severity: Severity
    var enabled: Bool
    var createdAt: Date
    var lastCheckedAt: Date?
    var lastEventAt: Date?
    var lastStatus: String?
    var lastError: String?

    var asWatcher: Watcher {
        let summary: String
        switch lastStatus {
        case "triggered": summary = "Needs attention"
        case "error": summary = lastError.map { "Check failed: \($0)" } ?? "Check failed"
        case "ok": summary = "OK"
        default: summary = enabled ? "Waiting for the first check" : "Paused"
        }
        let quiet = lastStatus == "ok" || lastStatus == nil || !enabled
        return Watcher(
            id: id, name: name, summary: enabled ? summary : "Paused",
            severity: quiet ? .info : severity,
            lastEventAt: lastEventAt ?? lastCheckedAt ?? createdAt
        )
    }
}

struct WatchListResponse: Decodable {
    var watches: [WatchDTO]
}
