// Migrations are embedded as strings so the build needs no asset copying.
export const migrations: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE sessions (
        id                  TEXT PRIMARY KEY,
        provider            TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        title               TEXT NOT NULL,
        project_path        TEXT,
        project_name        TEXT,
        status              TEXT NOT NULL,
        managed             INTEGER NOT NULL DEFAULT 1,
        turn_count          INTEGER NOT NULL DEFAULT 0,
        tags                TEXT NOT NULL DEFAULT '[]',
        created_at          TEXT NOT NULL,
        last_activity_at    TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_sessions_provider_sid ON sessions(provider, provider_session_id);
      CREATE INDEX idx_sessions_status ON sessions(status);

      CREATE TABLE messages (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        id              TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,
        session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        provider        TEXT,
        sender          TEXT NOT NULL,
        type            TEXT NOT NULL,
        severity        TEXT NOT NULL,
        text            TEXT NOT NULL,
        metadata        TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_messages_conversation ON messages(conversation_id, seq);
      CREATE INDEX idx_messages_created ON messages(created_at);

      CREATE TABLE devices (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        platform     TEXT,
        token_hash   TEXT NOT NULL UNIQUE,
        created_at   TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at   TEXT
      );

      CREATE TABLE pairing_codes (
        code_hash  TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        used_at    TEXT
      );

      CREATE TABLE audit_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        ts        TEXT NOT NULL,
        device_id TEXT,
        action    TEXT NOT NULL,
        detail    TEXT
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE approvals (
        id           TEXT PRIMARY KEY,
        session_id   TEXT,
        source       TEXT NOT NULL,
        tool         TEXT NOT NULL,
        summary      TEXT NOT NULL,
        reasons      TEXT NOT NULL DEFAULT '[]',
        status       TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        resolved_at  TEXT,
        resolved_by  TEXT,
        note         TEXT
      );
      CREATE INDEX idx_approvals_status ON approvals(status);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE watches (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        type              TEXT NOT NULL,
        config            TEXT NOT NULL,
        interval_sec      INTEGER NOT NULL,
        severity          TEXT NOT NULL,
        session_id        TEXT,
        enabled           INTEGER NOT NULL DEFAULT 1,
        state             TEXT NOT NULL DEFAULT '{}',
        wake              TEXT,
        notify_on_resolve INTEGER NOT NULL DEFAULT 1,
        repeat_min        INTEGER,
        created_at        TEXT NOT NULL,
        last_checked_at   TEXT,
        last_event_at     TEXT,
        last_status       TEXT,
        last_error        TEXT
      );
      CREATE INDEX idx_watches_enabled ON watches(enabled);

      CREATE TABLE watch_events (
        id       TEXT PRIMARY KEY,
        watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
        ts       TEXT NOT NULL,
        kind     TEXT NOT NULL,
        severity TEXT NOT NULL,
        summary  TEXT NOT NULL,
        detail   TEXT
      );
      CREATE INDEX idx_watch_events_watch ON watch_events(watch_id, ts);

      CREATE TABLE notifications (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       TEXT NOT NULL,
        event_id TEXT,
        channel  TEXT NOT NULL,
        status   TEXT NOT NULL,
        severity TEXT NOT NULL,
        title    TEXT NOT NULL,
        detail   TEXT
      );
      CREATE INDEX idx_notifications_ts ON notifications(ts);

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 4,
    sql: `
      -- Every Claude/Codex session found on this machine, whether or not Helix started it.
      CREATE TABLE discovered_sessions (
        key                 TEXT PRIMARY KEY,
        provider            TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        title               TEXT,
        project_path        TEXT,
        git_branch          TEXT,
        model               TEXT,
        cli_version         TEXT,
        created_at          TEXT,
        last_activity_at    TEXT,
        message_count       INTEGER NOT NULL DEFAULT 0,
        first_user          TEXT,
        last_user           TEXT,
        last_user_at        TEXT,
        last_assistant      TEXT,
        task_state          TEXT,
        source_file         TEXT NOT NULL,
        file_size           INTEGER NOT NULL DEFAULT 0,
        file_mtime_ms       INTEGER NOT NULL DEFAULT 0,
        parsed_bytes        INTEGER NOT NULL DEFAULT 0,
        head_len            INTEGER NOT NULL DEFAULT 0,
        head_hash           TEXT,
        live                INTEGER NOT NULL DEFAULT 0,
        live_status         TEXT,
        live_pid            INTEGER,
        live_name           TEXT,
        live_kind           TEXT,
        live_since_ms       INTEGER,
        indexed_at          TEXT NOT NULL
      );
      CREATE INDEX idx_discovered_activity ON discovered_sessions(last_activity_at);
      CREATE INDEX idx_discovered_provider ON discovered_sessions(provider, provider_session_id);

      -- When continuing a session from the phone while it is still open elsewhere, the gateway forks it.
      ALTER TABLE sessions ADD COLUMN fork_from TEXT;
    `,
  },
  {
    version: 5,
    sql: `
      -- Long-lived credentials for Claude/Codex sessions running on this PC (terminal, IDE, anywhere).
      -- Unlike per-turn agent tokens these survive gateway restarts. Only a hash is stored.
      CREATE TABLE local_tokens (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        scope        TEXT NOT NULL,
        token_hash   TEXT NOT NULL UNIQUE,
        created_at   TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at   TEXT
      );
    `,
  },
  {
    version: 6,
    sql: `
      -- What Claude Code hooks told us (turn finished, needs permission, ...). A small rolling log.
      CREATE TABLE agent_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         TEXT NOT NULL,
        provider   TEXT NOT NULL,
        event      TEXT NOT NULL,
        session_id TEXT,
        cwd        TEXT,
        message    TEXT,
        outcome    TEXT
      );
      CREATE INDEX idx_agent_events_ts ON agent_events(ts);
    `,
  },
  {
    version: 7,
    sql: `
      -- "router" sessions are the General Claude front door; they are hidden from normal session lists.
      ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'agent';

      -- A route is one phone conversation. It starts at its router session and can be handed to any other
      -- session mid-conversation (the same call/chat continues; only who is answering changes).
      CREATE TABLE routes (
        id                TEXT PRIMARY KEY,
        title             TEXT NOT NULL,
        router_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        target_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        visited           TEXT NOT NULL DEFAULT '[]',
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_routes_router ON routes(router_session_id);

      -- Short names for sessions or projects ("cat training", "orbit") for Siri, CarPlay and the router.
      CREATE TABLE aliases (
        name         TEXT PRIMARY KEY COLLATE NOCASE,
        session_key  TEXT,
        project_path TEXT,
        created_at   TEXT NOT NULL
      );
    `,
  },
  {
    version: 8,
    sql: `
      -- APNs tokens the app registers. "alert" is the normal push token, "voip" the PushKit token for calls.
      -- environment records which APNs host accepts the token (debug builds use sandbox, TestFlight/App Store production).
      CREATE TABLE push_tokens (
        device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL,
        token       TEXT NOT NULL,
        environment TEXT NOT NULL,
        bundle_id   TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        invalid_at  TEXT,
        PRIMARY KEY (device_id, kind)
      );

      -- Context a route hands to its router with the user's NEXT message (e.g. why Helix is calling), then forgets.
      ALTER TABLE routes ADD COLUMN pending_context TEXT;

      -- Phone calls between Helix and the user, either direction.
      CREATE TABLE calls (
        id           TEXT PRIMARY KEY,
        direction    TEXT NOT NULL,
        status       TEXT NOT NULL,
        severity     TEXT NOT NULL,
        title        TEXT NOT NULL,
        summary      TEXT NOT NULL DEFAULT '',
        script       TEXT NOT NULL DEFAULT '',
        expects      TEXT NOT NULL DEFAULT 'conversation',
        session_id   TEXT,
        approval_id  TEXT,
        route_id     TEXT,
        device_id    TEXT,
        created_at   TEXT NOT NULL,
        answered_at  TEXT,
        ended_at     TEXT,
        end_reason   TEXT
      );
      CREATE INDEX idx_calls_created ON calls(created_at);
    `,
  },
  {
    version: 9,
    sql: `
      -- How serious the moment is for voice replies on this route (set when a call is answered), so the
      -- personality stays dialled down for the whole of an urgent call.
      ALTER TABLE routes ADD COLUMN voice_severity TEXT;
    `,
  },
  {
    version: 10,
    sql: `
      -- Hosted (internet-facing) MCP tokens can expire.
      ALTER TABLE local_tokens ADD COLUMN expires_at TEXT;
    `,
  },
  {
    version: 11,
    sql: `
      -- OAuth 2.1 for hosted connectors (ChatGPT / Claude). Only hashes of secrets are stored.
      CREATE TABLE oauth_clients (
        client_id     TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
      -- One-time codes printed on the PC (npm run hosted -- code) that let the owner approve a connector.
      CREATE TABLE oauth_approval_codes (
        code_hash  TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        used_at    TEXT
      );
      CREATE TABLE oauth_auth_codes (
        code_hash      TEXT PRIMARY KEY,
        client_id      TEXT NOT NULL,
        redirect_uri   TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        expires_at     TEXT NOT NULL,
        used_at        TEXT
      );
      CREATE TABLE oauth_refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        client_id  TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
    `,
  },
  {
    version: 12,
    sql: `
      -- What every turn Helix ran consumed (tokens by kind), for finding what drains the subscription.
      CREATE TABLE turn_usage (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        provider    TEXT NOT NULL,
        model       TEXT,
        input       INTEGER NOT NULL,
        cache_read  INTEGER NOT NULL,
        cache_write INTEGER NOT NULL,
        output      INTEGER NOT NULL,
        cost_usd    REAL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX turn_usage_time ON turn_usage (created_at);
    `,
  },
  {
    version: 13,
    sql: `
      ALTER TABLE local_tokens ADD COLUMN desktop_allowed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE local_tokens ADD COLUMN oauth_client_id TEXT;
      ALTER TABLE oauth_clients ADD COLUMN desktop_allowed INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 14,
    sql: `
      -- Device-key request signing: the public half of the key the phone keeps in its Secure Enclave (see api/device-signing.ts).
      ALTER TABLE devices ADD COLUMN public_key TEXT;
      ALTER TABLE devices ADD COLUMN key_enrolled_at TEXT;
    `,
  },
];
