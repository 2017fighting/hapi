CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    tag TEXT,
    namespace TEXT NOT NULL DEFAULT 'default',
    machine_id TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    metadata TEXT,
    metadata_version BIGINT DEFAULT 1,
    agent_state TEXT,
    agent_state_version BIGINT DEFAULT 1,
    model TEXT,
    model_reasoning_effort TEXT,
    effort TEXT,
    service_tier TEXT,
    todos TEXT,
    todos_updated_at BIGINT,
    team_state TEXT,
    team_state_updated_at BIGINT,
    active INTEGER DEFAULT 0,
    active_at BIGINT,
    seq BIGINT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_tag ON sessions(tag);
CREATE INDEX IF NOT EXISTS idx_sessions_tag_namespace ON sessions(tag, namespace);

CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL DEFAULT 'default',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    metadata TEXT,
    metadata_version BIGINT DEFAULT 1,
    runner_state TEXT,
    runner_state_version BIGINT DEFAULT 1,
    active INTEGER DEFAULT 0,
    active_at BIGINT,
    seq BIGINT DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_machines_namespace ON machines(namespace);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    seq BIGINT NOT NULL,
    local_id TEXT,
    invoked_at BIGINT,
    scheduled_at BIGINT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_session_position
    ON messages(session_id, COALESCE(invoked_at, created_at) DESC, seq DESC);
CREATE INDEX IF NOT EXISTS idx_messages_scheduled_pending
    ON messages(scheduled_at)
    WHERE scheduled_at IS NOT NULL AND invoked_at IS NULL;

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    platform TEXT NOT NULL,
    platform_user_id TEXT NOT NULL,
    namespace TEXT NOT NULL DEFAULT 'default',
    created_at BIGINT NOT NULL,
    UNIQUE(platform, platform_user_id)
);
CREATE INDEX IF NOT EXISTS idx_users_platform ON users(platform);
CREATE INDEX IF NOT EXISTS idx_users_platform_namespace ON users(platform, namespace);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id SERIAL PRIMARY KEY,
    namespace TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    UNIQUE(namespace, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_namespace ON push_subscriptions(namespace);
