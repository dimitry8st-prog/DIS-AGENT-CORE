-- Additive scoping for multi-bot/project isolation. Apply after 001 + 002.
-- Does NOT DROP/TRUNCATE data. Does NOT rewrite historical event_id values.
-- Legacy rows without scope stay protected; remapping requires explicit operator map + dry-run.

BEGIN;

-- Trusted source scope columns on processed events (nullable for legacy rows).
ALTER TABLE processed_events
  ADD COLUMN IF NOT EXISTS channel TEXT,
  ADD COLUMN IF NOT EXISTS project_id TEXT,
  ADD COLUMN IF NOT EXISTS bot_id TEXT,
  ADD COLUMN IF NOT EXISTS external_event_id TEXT,
  ADD COLUMN IF NOT EXISTS source_id TEXT;

CREATE INDEX IF NOT EXISTS idx_processed_events_scope
  ON processed_events(project_id, bot_id, channel, external_event_id);

-- Operator-supplied mapping for legacy unscoped events. Empty until filled deliberately.
CREATE TABLE IF NOT EXISTS legacy_event_scope_map (
  event_id TEXT PRIMARY KEY REFERENCES processed_events(event_id),
  channel TEXT NOT NULL,
  project_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  source_id TEXT,
  confirmed_by TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS legacy_context_scope_map (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  project_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'telegram',
  dialogue_id TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT
);

-- Expand bot_context: leave old PK(user_id) rows in place; add scoped table.
-- New writes go to bot_context_scoped. Old rows readable via legacy map dry-run/apply.
CREATE TABLE IF NOT EXISTS bot_context_scoped (
  project_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  dialogue_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  state TEXT NOT NULL DEFAULT 'new',
  current_order_id UUID,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  processing_lock BOOLEAN NOT NULL DEFAULT false,
  locked_at TIMESTAMPTZ,
  lock_owner TEXT,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, bot_id, channel, dialogue_id)
);

CREATE INDEX IF NOT EXISTS idx_bot_context_scoped_user
  ON bot_context_scoped(user_id, project_id, bot_id);

-- Dry-run: report legacy events that still lack scope and any conflicting map entries.
CREATE OR REPLACE FUNCTION dis_core_legacy_event_scope_dry_run()
RETURNS JSONB
LANGUAGE plpgsql STABLE AS $$
DECLARE
  unscoped BIGINT;
  mapped BIGINT;
  conflicts BIGINT;
BEGIN
  SELECT count(*) INTO unscoped FROM processed_events
    WHERE project_id IS NULL OR bot_id IS NULL OR channel IS NULL OR external_event_id IS NULL;
  SELECT count(*) INTO mapped FROM legacy_event_scope_map m
    JOIN processed_events e ON e.event_id = m.event_id
    WHERE e.project_id IS NULL;
  SELECT count(*) INTO conflicts FROM legacy_event_scope_map m
    JOIN processed_events e ON e.event_id = m.event_id
    WHERE e.project_id IS NOT NULL AND (
      e.project_id IS DISTINCT FROM m.project_id OR
      e.bot_id IS DISTINCT FROM m.bot_id OR
      e.channel IS DISTINCT FROM m.channel OR
      e.external_event_id IS DISTINCT FROM m.external_event_id
    );
  RETURN jsonb_build_object(
    'unscoped_events', unscoped,
    'mapped_pending', mapped,
    'conflicts', conflicts,
    'auto_assign', false,
    'note', 'Fill legacy_event_scope_map explicitly; call dis_core_legacy_event_scope_apply() only after review.'
  );
END;
$$;

-- Apply only explicitly mapped rows. Never invents project_id. Idempotent.
CREATE OR REPLACE FUNCTION dis_core_legacy_event_scope_apply()
RETURNS JSONB
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  updated_count BIGINT := 0;
BEGIN
  UPDATE processed_events e SET
    channel = m.channel,
    project_id = m.project_id,
    bot_id = m.bot_id,
    external_event_id = m.external_event_id,
    source_id = m.source_id
  FROM legacy_event_scope_map m
  WHERE e.event_id = m.event_id
    AND e.project_id IS NULL
    AND m.project_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
    AND m.bot_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
    AND m.channel ~ '^[A-Za-z0-9_]{1,32}$'
    AND position('|' in m.channel) = 0
    AND position('|' in m.project_id) = 0
    AND position('|' in m.bot_id) = 0;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  -- Remapping MUST NOT reopen completed/failed/processing events for reprocessing.
  -- event_id (PK) and status are intentionally unchanged.
  RETURN jsonb_build_object(
    'updated', updated_count,
    'statuses_preserved', true,
    'event_ids_preserved', true
  );
END;
$$;

CREATE OR REPLACE FUNCTION dis_core_legacy_context_scope_dry_run()
RETURNS JSONB
LANGUAGE plpgsql STABLE AS $$
DECLARE
  legacy_rows BIGINT;
  mapped BIGINT;
BEGIN
  SELECT count(*) INTO legacy_rows FROM bot_context;
  SELECT count(*) INTO mapped FROM legacy_context_scope_map;
  RETURN jsonb_build_object(
    'legacy_context_rows', legacy_rows,
    'mapped', mapped,
    'auto_assign', false,
    'note', 'Fill legacy_context_scope_map; apply copies into bot_context_scoped without deleting legacy rows.'
  );
END;
$$;

CREATE OR REPLACE FUNCTION dis_core_legacy_context_scope_apply()
RETURNS JSONB
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  inserted_count BIGINT := 0;
BEGIN
  INSERT INTO bot_context_scoped(
    project_id, bot_id, channel, dialogue_id, user_id,
    state, current_order_id, payload, status,
    processing_lock, locked_at, lock_owner, expires_at, updated_at
  )
  SELECT
    m.project_id, m.bot_id, m.channel, m.dialogue_id, c.user_id,
    c.state, c.current_order_id, c.payload, c.status,
    c.processing_lock, c.locked_at, c.lock_owner, c.expires_at, c.updated_at
  FROM bot_context c
  JOIN legacy_context_scope_map m ON m.user_id = c.user_id
  ON CONFLICT (project_id, bot_id, channel, dialogue_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN jsonb_build_object('inserted', inserted_count, 'legacy_rows_retained', true);
END;
$$;

CREATE OR REPLACE FUNCTION dis_core_reserve(p JSONB) RETURNS JSONB
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  inserted BOOLEAN := false;
  existing processed_events%ROWTYPE;
  eid TEXT := p->>'event_id';
BEGIN
  IF coalesce(p->>'project_id','') = '' OR coalesce(p->>'bot_id','') = ''
     OR coalesce(p->>'channel','') = '' OR coalesce(p->>'external_event_id','') = '' THEN
    RETURN p || jsonb_build_object('idempotency', jsonb_build_object(
      'acquired', false, 'duplicate', false, 'busy', false, 'failed', false,
      'existing_status', null, 'rejected', true, 'reason', 'missing_scope'));
  END IF;

  INSERT INTO processed_events(
    event_id, source, correlation_id, workflow_execution_id,
    channel, project_id, bot_id, external_event_id, source_id
  )
  VALUES(
    eid, p->>'source', p->>'correlation_id', p->>'execution_id',
    p->>'channel', p->>'project_id', p->>'bot_id', p->>'external_event_id', p->>'source_id'
  )
  ON CONFLICT (event_id) DO NOTHING RETURNING true INTO inserted;

  IF coalesce(inserted, false) THEN
    INSERT INTO event_log(event_id, correlation_id, source, event_type, sanitized_payload)
    VALUES(eid, p->>'correlation_id', p->>'source', p->>'event_type', '{}');
    RETURN p || jsonb_build_object('idempotency', jsonb_build_object(
      'acquired', true, 'duplicate', false, 'busy', false, 'failed', false,
      'existing_status', null, 'rejected', false));
  END IF;

  SELECT * INTO STRICT existing FROM processed_events WHERE event_id = eid;
  -- Same internal key always same scope; cross-bot independence comes from distinct event_id.
  RETURN p || jsonb_build_object('correlation_id', existing.correlation_id,
    'idempotency', jsonb_build_object('acquired', false,
      'duplicate', existing.status = 'completed',
      'busy', existing.status = 'processing',
      'failed', existing.status NOT IN ('completed', 'processing'),
      'existing_status', existing.status, 'rejected', false));
END;
$$;

CREATE OR REPLACE FUNCTION dis_core_auth(p JSONB) RETURNS JSONB
LANGUAGE plpgsql VOLATILE AS $$
DECLARE u users%ROWTYPE;
BEGIN
  -- Lookup by telegram_id is NOT proof of sender identity; ingress already authenticated the source.
  IF coalesce(p->>'project_id','') = '' OR coalesce(p->>'bot_id','') = '' THEN
    RETURN p || jsonb_build_object('auth', jsonb_build_object(
      'found', false, 'registration_required', false, 'allowed', false,
      'user', null, 'rejected', true, 'reason', 'missing_scope'));
  END IF;
  SELECT * INTO u FROM users WHERE telegram_id = nullif(p->>'user_id', '')::bigint;
  RETURN p || jsonb_build_object('auth', jsonb_build_object(
    'found', u.id IS NOT NULL,
    'registration_required', u.id IS NULL,
    'allowed', u.id IS NOT NULL AND u.status = 'active',
    'user', CASE WHEN u.id IS NULL THEN null ELSE
      jsonb_build_object('id', u.id, 'status', u.status) END,
    'rejected', false,
    'scope', jsonb_build_object(
      'project_id', p->>'project_id',
      'bot_id', p->>'bot_id',
      'channel', p->>'channel',
      'dialogue_id', p->>'dialogue_id'
    )));
END;
$$;

CREATE OR REPLACE FUNCTION dis_core_context(p JSONB) RETURNS JSONB
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  c bot_context_scoped%ROWTYPE;
  expired BOOLEAN := false;
  stale BOOLEAN := false;
  owned BOOLEAN := false;
  pid TEXT := p->>'project_id';
  bid TEXT := p->>'bot_id';
  ch TEXT := coalesce(p->>'channel', 'telegram');
  did TEXT := p->>'dialogue_id';
BEGIN
  IF coalesce((p#>>'{auth,allowed}')::boolean, false)
     AND pid IS NOT NULL AND bid IS NOT NULL AND did IS NOT NULL THEN
    SELECT * INTO c FROM bot_context_scoped
    WHERE project_id = pid AND bot_id = bid AND channel = ch AND dialogue_id = did
    FOR UPDATE;
    IF c.user_id IS NOT NULL THEN
      -- Scope check: context user must match authenticated lookup user.
      IF c.user_id IS DISTINCT FROM (p#>>'{auth,user,id}')::uuid THEN
        RETURN p || jsonb_build_object('context', jsonb_build_object(
          'exists', true, 'state', 'new', 'status', 'active', 'payload', '{}'::jsonb,
          'processing_lock', false, 'expired', false, 'stale', false,
          'lock_acquired', false, 'rejected', true, 'reason', 'user_scope_mismatch'));
      END IF;
      expired := c.state = 'expired' OR c.status = 'expired'
        OR (c.expires_at IS NOT NULL AND c.expires_at <= now());
      stale := c.processing_lock AND
        (c.locked_at IS NULL OR c.locked_at <= now() - interval '10 minutes');
      IF NOT c.processing_lock AND c.status IN ('active', 'expired') THEN
        UPDATE bot_context_scoped SET processing_lock = true, locked_at = now(),
          lock_owner = p->>'execution_id', updated_at = now()
        WHERE project_id = c.project_id AND bot_id = c.bot_id
          AND channel = c.channel AND dialogue_id = c.dialogue_id;
        owned := true;
      END IF;
    END IF;
  END IF;
  RETURN p || jsonb_build_object('context', jsonb_build_object(
    'exists', c.user_id IS NOT NULL,
    'state', coalesce(c.state, 'new'),
    'status', coalesce(c.status, 'active'),
    'payload', '{}'::jsonb,
    'processing_lock', coalesce(c.processing_lock, false),
    'locked_at', c.locked_at, 'expires_at', c.expires_at,
    'expired', coalesce(expired, false), 'stale', coalesce(stale, false),
    'lock_acquired', owned,
    'scope', jsonb_build_object(
      'project_id', pid, 'bot_id', bid, 'channel', ch, 'dialogue_id', did
    )));
END;
$$;

CREATE OR REPLACE FUNCTION dis_core_finish(p JSONB, is_failure BOOLEAN DEFAULT false)
RETURNS JSONB LANGUAGE plpgsql VOLATILE AS $$
DECLARE recorded BOOLEAN := false;
BEGIN
  UPDATE processed_events SET status = CASE WHEN is_failure THEN 'failed' ELSE 'completed' END,
    completed_at = now(), user_id = nullif(p#>>'{auth,user,id}', '')::uuid
  WHERE event_id = p->>'event_id' AND status = 'processing'
    AND workflow_execution_id = p->>'execution_id'
    AND (project_id IS NULL OR project_id = p->>'project_id')
    AND (bot_id IS NULL OR bot_id = p->>'bot_id')
  RETURNING true INTO recorded;
  IF coalesce(recorded, false) THEN
    UPDATE bot_context_scoped SET processing_lock = false, locked_at = null, lock_owner = null,
      updated_at = now()
    WHERE lock_owner = p->>'execution_id' AND processing_lock
      AND project_id = p->>'project_id' AND bot_id = p->>'bot_id'
      AND channel = coalesce(p->>'channel','telegram')
      AND dialogue_id = p->>'dialogue_id';
    INSERT INTO application_log(correlation_id, workflow, action, status, details)
    VALUES(p->>'correlation_id', 'WF-00', 'core_complete',
      CASE WHEN is_failure THEN 'failed' ELSE 'completed' END,
      jsonb_build_object(
        'event_id', p->>'event_id',
        'project_id', p->>'project_id',
        'bot_id', p->>'bot_id'
      ));
    IF is_failure THEN
      INSERT INTO failed_events(event_id, correlation_id, workflow, node, payload,
        error_type, error_message)
      VALUES(p->>'event_id', p->>'correlation_id', 'WF-00', 'core_chain', '{}',
        'core_processing_error', 'Core processing failed');
    END IF;
  END IF;
  RETURN p || jsonb_build_object('persistence', jsonb_build_object(
    'recorded', coalesce(recorded, false),
    'status', CASE WHEN is_failure THEN 'failed' ELSE 'completed' END));
END;
$$;

COMMIT;
