-- Additive first-stage processing helpers. Apply after 001_core.sql.
-- Functions are SECURITY INVOKER: use a role scoped to this test/application DB.
BEGIN;
ALTER TABLE bot_context ADD COLUMN IF NOT EXISTS lock_owner TEXT;

CREATE OR REPLACE FUNCTION dis_core_reserve(p JSONB) RETURNS JSONB
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  inserted BOOLEAN := false;
  existing processed_events%ROWTYPE;
BEGIN
  INSERT INTO processed_events(event_id, source, correlation_id, workflow_execution_id)
  VALUES(p->>'event_id', p->>'source', p->>'correlation_id', p->>'execution_id')
  ON CONFLICT (event_id) DO NOTHING RETURNING true INTO inserted;
  IF coalesce(inserted, false) THEN
    -- Raw payload, headers, free text and personal details are never persisted.
    INSERT INTO event_log(event_id, correlation_id, source, event_type, sanitized_payload)
    VALUES(p->>'event_id', p->>'correlation_id', p->>'source', p->>'event_type', '{}');
    RETURN p || jsonb_build_object('idempotency', jsonb_build_object(
      'acquired', true, 'duplicate', false, 'busy', false, 'failed', false,
      'existing_status', null));
  END IF;
  -- Separate statement intentionally: after a concurrent INSERT commits,
  -- READ COMMITTED sees it. A single INSERT CTE + SELECT can miss that row.
  SELECT * INTO STRICT existing FROM processed_events WHERE event_id = p->>'event_id';
  RETURN p || jsonb_build_object('correlation_id', existing.correlation_id,
    'idempotency', jsonb_build_object('acquired', false,
      'duplicate', existing.status = 'completed', 'busy', existing.status = 'processing',
      'failed', existing.status NOT IN ('completed', 'processing'),
      'existing_status', existing.status));
END;
$$;

CREATE OR REPLACE FUNCTION dis_core_auth(p JSONB) RETURNS JSONB
LANGUAGE plpgsql VOLATILE AS $$
DECLARE u users%ROWTYPE;
BEGIN
  SELECT * INTO u FROM users WHERE telegram_id = nullif(p->>'user_id', '')::bigint;
  RETURN p || jsonb_build_object('auth', jsonb_build_object(
    'found', u.id IS NOT NULL, 'registration_required', u.id IS NULL,
    'allowed', u.id IS NOT NULL AND u.status = 'active',
    'user', CASE WHEN u.id IS NULL THEN null ELSE
      jsonb_build_object('id', u.id, 'status', u.status) END));
END;
$$;

CREATE OR REPLACE FUNCTION dis_core_context(p JSONB) RETURNS JSONB
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  c bot_context%ROWTYPE;
  expired BOOLEAN := false;
  stale BOOLEAN := false;
  owned BOOLEAN := false;
BEGIN
  IF coalesce((p#>>'{auth,allowed}')::boolean, false) THEN
    SELECT * INTO c FROM bot_context
    WHERE user_id = (p#>>'{auth,user,id}')::uuid FOR UPDATE;
    IF c.user_id IS NOT NULL THEN
      expired := c.state = 'expired' OR c.status = 'expired'
        OR (c.expires_at IS NOT NULL AND c.expires_at <= now());
      stale := c.processing_lock AND
        (c.locked_at IS NULL OR c.locked_at <= now() - interval '10 minutes');
      IF NOT c.processing_lock AND c.status IN ('active', 'expired') THEN
        UPDATE bot_context SET processing_lock = true, locked_at = now(),
          lock_owner = p->>'execution_id', updated_at = now() WHERE user_id = c.user_id;
        owned := true;
      END IF;
    END IF;
  END IF;
  RETURN p || jsonb_build_object('context', jsonb_build_object(
    'exists', c.user_id IS NOT NULL, 'state', coalesce(c.state, 'new'),
    'status', coalesce(c.status, 'active'), 'payload', '{}'::jsonb,
    'processing_lock', coalesce(c.processing_lock, false),
    'locked_at', c.locked_at, 'expires_at', c.expires_at,
    'expired', coalesce(expired, false), 'stale', coalesce(stale, false),
    'lock_acquired', owned));
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
  RETURNING true INTO recorded;
  IF coalesce(recorded, false) THEN
    UPDATE bot_context SET processing_lock = false, locked_at = null, lock_owner = null,
      updated_at = now() WHERE lock_owner = p->>'execution_id' AND processing_lock;
    INSERT INTO application_log(correlation_id, workflow, action, status, details)
    VALUES(p->>'correlation_id', 'WF-00', 'core_complete',
      CASE WHEN is_failure THEN 'failed' ELSE 'completed' END,
      jsonb_build_object('event_id', p->>'event_id'));
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
