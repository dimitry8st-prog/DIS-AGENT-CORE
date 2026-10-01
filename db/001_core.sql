CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT UNIQUE,
  email TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  correlation_id TEXT NOT NULL,
  user_id UUID REFERENCES users(id),
  workflow_execution_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS bot_context (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'new',
  current_order_id UUID,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  processing_lock BOOLEAN NOT NULL DEFAULT false,
  locked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_log (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT,
  correlation_id TEXT NOT NULL,
  source TEXT NOT NULL,
  event_type TEXT,
  user_id UUID REFERENCES users(id),
  sanitized_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS application_log (
  id BIGSERIAL PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  workflow TEXT,
  node TEXT,
  action TEXT,
  status TEXT,
  duration_ms INTEGER,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  old_value JSONB,
  new_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS failed_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT,
  correlation_id TEXT NOT NULL,
  workflow TEXT,
  node TEXT,
  payload JSONB,
  error_type TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'failed',
  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_processed_events_correlation ON processed_events(correlation_id);
CREATE INDEX IF NOT EXISTS idx_event_log_correlation ON event_log(correlation_id);
CREATE INDEX IF NOT EXISTS idx_application_log_correlation ON application_log(correlation_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_correlation ON audit_log(correlation_id);
CREATE INDEX IF NOT EXISTS idx_failed_events_status ON failed_events(status);
