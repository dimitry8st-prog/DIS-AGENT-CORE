-- Forward-only review fixes. Apply after either historical variant of 003.
-- No data remapping, deletion, status reset, or old-event replay is performed.
BEGIN;
LOCK TABLE processed_events IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM processed_events
    WHERE project_id IS NOT NULL AND bot_id IS NOT NULL AND channel IS NOT NULL AND external_event_id IS NOT NULL
    GROUP BY project_id,bot_id,channel,external_event_id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'scope_identity_conflict: operator reconciliation required' USING ERRCODE='23505';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_processed_events_scope_identity
ON processed_events(project_id,bot_id,channel,external_event_id)
WHERE project_id IS NOT NULL AND bot_id IS NOT NULL AND channel IS NOT NULL AND external_event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION dis_core_legacy_event_scope_dry_run()
RETURNS JSONB
LANGUAGE plpgsql STABLE AS $$
DECLARE
  unscoped BIGINT;
  mapped BIGINT;
  conflicts BIGINT;
  scope_identity_conflicts BIGINT;
  data_dup_groups BIGINT;
  map_dup_groups BIGINT;
  map_vs_other BIGINT;
  unique_index_present BOOLEAN;
BEGIN
  SELECT count(*) INTO unscoped FROM processed_events
    WHERE project_id IS NULL OR bot_id IS NULL OR channel IS NULL OR external_event_id IS NULL;
  SELECT count(*) INTO mapped FROM legacy_event_scope_map m
    JOIN processed_events e ON e.event_id = m.event_id
    WHERE e.project_id IS NULL;
  SELECT count(*) INTO conflicts FROM legacy_event_scope_map m
    JOIN processed_events e ON e.event_id = m.event_id
    WHERE (e.project_id IS NOT NULL AND e.project_id IS DISTINCT FROM m.project_id)
       OR (e.bot_id IS NOT NULL AND e.bot_id IS DISTINCT FROM m.bot_id)
       OR (e.channel IS NOT NULL AND e.channel IS DISTINCT FROM m.channel)
       OR (e.external_event_id IS NOT NULL AND e.external_event_id IS DISTINCT FROM m.external_event_id);
  SELECT count(*) INTO data_dup_groups FROM (
    SELECT 1 FROM processed_events
    WHERE project_id IS NOT NULL AND bot_id IS NOT NULL
      AND channel IS NOT NULL AND external_event_id IS NOT NULL
    GROUP BY project_id, bot_id, channel, external_event_id
    HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO map_dup_groups FROM (
    SELECT 1 FROM legacy_event_scope_map
    GROUP BY channel, project_id, bot_id, external_event_id
    HAVING count(*) > 1
  ) d;
  SELECT count(*) INTO map_vs_other FROM legacy_event_scope_map m
    JOIN processed_events e
      ON e.project_id = m.project_id AND e.bot_id = m.bot_id
     AND e.channel = m.channel AND e.external_event_id = m.external_event_id
     AND e.event_id IS DISTINCT FROM m.event_id;
  scope_identity_conflicts := data_dup_groups + map_dup_groups + map_vs_other;
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = ANY (current_schemas(false))
      AND indexname = 'uq_processed_events_scope_identity'
  ) INTO unique_index_present;
  RETURN jsonb_build_object(
    'unscoped_events', unscoped,
    'mapped_pending', mapped,
    'conflicts', conflicts,
    'scope_identity_conflicts', scope_identity_conflicts,
    'data_duplicate_scope_groups', data_dup_groups,
    'map_duplicate_scope_groups', map_dup_groups,
    'map_conflicts_with_other_event', map_vs_other,
    'unique_index_present', unique_index_present,
    'auto_assign', false,
    'note', 'Fill legacy_event_scope_map explicitly; resolve scope_identity_conflicts before apply. No auto-assign.'
  );
END;
$$;

-- Apply only explicitly mapped rows. Never invents project_id. Idempotent.
-- Refuses when dry-run reports scope identity conflicts; does not delete rows.
CREATE OR REPLACE FUNCTION dis_core_legacy_event_scope_apply()
RETURNS JSONB
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  updated_count BIGINT := 0;
  preflight JSONB;
  conflict_count BIGINT;
BEGIN
  preflight := dis_core_legacy_event_scope_dry_run();
  conflict_count := coalesce((preflight->>'scope_identity_conflicts')::bigint, 0)
    + coalesce((preflight->>'conflicts')::bigint, 0);
  IF conflict_count > 0 THEN
    RETURN jsonb_build_object(
      'updated', 0,
      'statuses_preserved', true,
      'event_ids_preserved', true,
      'refused_due_to_conflicts', true,
      'scope_identity_conflicts', (preflight->>'scope_identity_conflicts')::bigint,
      'conflicts', (preflight->>'conflicts')::bigint
    );
  END IF;

  UPDATE processed_events e SET
    channel = m.channel,
    project_id = m.project_id,
    bot_id = m.bot_id,
    external_event_id = m.external_event_id,
    source_id = m.source_id
  FROM legacy_event_scope_map m
  WHERE e.event_id = m.event_id
    AND (e.project_id IS NULL OR e.bot_id IS NULL OR e.channel IS NULL OR e.external_event_id IS NULL)
    AND m.project_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
    AND m.bot_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
    AND m.channel ~ '^[A-Za-z0-9_]{1,32}$'
    AND position('|' in m.channel) = 0
    AND position('|' in m.project_id) = 0
    AND position('|' in m.bot_id) = 0;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  -- Remapping MUST NOT reopen completed/failed/processing events for reprocessing.
  -- event_id (PK), status, and correlation_id are intentionally unchanged.
  RETURN jsonb_build_object(
    'updated', updated_count,
    'statuses_preserved', true,
    'event_ids_preserved', true,
    'refused_due_to_conflicts', false
  );
END;
$$;


CREATE OR REPLACE FUNCTION dis_core_reserve(p JSONB) RETURNS JSONB
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  inserted BOOLEAN := false;
  existing processed_events%ROWTYPE;
  eid TEXT := p->>'event_id';
  ch TEXT := p->>'channel';
  pid TEXT := p->>'project_id';
  bid TEXT := p->>'bot_id';
  ext TEXT := p->>'external_event_id';
  scope_key TEXT;
  matches BIGINT;
BEGIN
  IF coalesce(pid,'') = '' OR coalesce(bid,'') = ''
     OR coalesce(ch,'') = '' OR coalesce(ext,'') = '' THEN
    RETURN p || jsonb_build_object('idempotency', jsonb_build_object(
      'acquired', false, 'duplicate', false, 'busy', false, 'failed', false,
      'existing_status', null, 'existing_event_id', null,
      'rejected', true, 'reason', 'missing_scope'));
  END IF;

  -- Serialize by confirmed scope identity (not only event_id) so legacy tg_42 and
  -- composite telegram|project|bot|42 cannot both acquire under concurrency.
  scope_key := ch || E'\x1f' || pid || E'\x1f' || bid || E'\x1f' || ext;
  PERFORM pg_advisory_xact_lock(hashtext(scope_key), hashtext(reverse(scope_key)));

  SELECT count(*) INTO matches FROM processed_events
  WHERE project_id = pid AND bot_id = bid AND channel = ch AND external_event_id = ext;
  IF matches > 1 THEN
    RETURN p || jsonb_build_object('idempotency', jsonb_build_object(
      'acquired',false,'duplicate',false,'busy',false,'failed',false,
      'rejected',true,'reason','scope_identity_conflict'));
  END IF;
  SELECT * INTO existing FROM processed_events
  WHERE project_id = pid AND bot_id = bid AND channel = ch AND external_event_id = ext;
  IF FOUND THEN
    RETURN p || jsonb_build_object('correlation_id', existing.correlation_id,
      'idempotency', jsonb_build_object('acquired', false,
        'duplicate', existing.status = 'completed',
        'busy', existing.status = 'processing',
        'failed', existing.status NOT IN ('completed', 'processing'),
        'existing_status', existing.status,
        'existing_event_id', existing.event_id,
        'rejected', false));
  END IF;

  BEGIN
    INSERT INTO processed_events(
      event_id, source, correlation_id, workflow_execution_id,
      channel, project_id, bot_id, external_event_id, source_id
    )
    VALUES(
      eid, p->>'source', p->>'correlation_id', p->>'execution_id',
      ch, pid, bid, ext, p->>'source_id'
    )
    ON CONFLICT (event_id) DO NOTHING RETURNING true INTO inserted;
  EXCEPTION WHEN unique_violation THEN
    -- Partial unique index on scope identity (different event_id, same scope).
    SELECT * INTO STRICT existing FROM processed_events
    WHERE project_id = pid AND bot_id = bid AND channel = ch AND external_event_id = ext;
    RETURN p || jsonb_build_object('correlation_id', existing.correlation_id,
      'idempotency', jsonb_build_object('acquired', false,
        'duplicate', existing.status = 'completed',
        'busy', existing.status = 'processing',
        'failed', existing.status NOT IN ('completed', 'processing'),
        'existing_status', existing.status,
        'existing_event_id', existing.event_id,
        'rejected', false));
  END;

  IF coalesce(inserted, false) THEN
    INSERT INTO event_log(event_id, correlation_id, source, event_type, sanitized_payload)
    VALUES(eid, p->>'correlation_id', p->>'source', p->>'event_type', '{}');
    RETURN p || jsonb_build_object('idempotency', jsonb_build_object(
      'acquired', true, 'duplicate', false, 'busy', false, 'failed', false,
      'existing_status', null, 'existing_event_id', null, 'rejected', false));
  END IF;

  SELECT * INTO STRICT existing FROM processed_events WHERE event_id = eid;
  IF existing.project_id IS DISTINCT FROM pid OR existing.bot_id IS DISTINCT FROM bid
      OR existing.channel IS DISTINCT FROM ch OR existing.external_event_id IS DISTINCT FROM ext THEN
    RETURN p || jsonb_build_object('idempotency',jsonb_build_object(
      'acquired',false,'duplicate',false,'busy',false,'failed',false,
      'rejected',true,'reason','event_scope_conflict'));
  END IF;
  RETURN p || jsonb_build_object('correlation_id', existing.correlation_id,
    'idempotency', jsonb_build_object('acquired', false,
      'duplicate', existing.status = 'completed',
      'busy', existing.status = 'processing',
      'failed', existing.status NOT IN ('completed', 'processing'),
      'existing_status', existing.status,
      'existing_event_id', existing.event_id,
      'rejected', false));
END;
$$;


COMMIT;
