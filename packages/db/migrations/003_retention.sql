CREATE ROLE sce_retention NOLOGIN NOSUPERUSER NOBYPASSRLS;
ALTER TABLE repository_watches
  ADD COLUMN max_memories integer NOT NULL DEFAULT 10000 CHECK(max_memories BETWEEN 1 AND 1000000),
  ADD COLUMN max_memory_bytes bigint NOT NULL DEFAULT 104857600 CHECK(max_memory_bytes BETWEEN 1024 AND 10737418240),
  ADD COLUMN memory_pruned_at timestamptz,
  ADD COLUMN memory_pruned_key text,
  ADD COLUMN last_retention_at timestamptz;
ALTER TABLE session_memories ADD COLUMN content_bytes bigint GENERATED ALWAYS AS (
  octet_length(summary)::bigint + octet_length(pending_work::text) + octet_length(blockers::text) + octet_length(source_key) + 512
) STORED;
CREATE INDEX memory_retention_idx ON session_memories(repo_id,occurred_at DESC,source_key DESC);
CREATE TABLE delta_retention_floors (
  project_id uuid PRIMARY KEY REFERENCES projects(id),
  cursor bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE delta_retention_floors ENABLE ROW LEVEL SECURITY;
ALTER TABLE delta_retention_floors FORCE ROW LEVEL SECURITY;
CREATE POLICY delta_floor_scope ON delta_retention_floors USING(sce_allowed(project_id)) WITH CHECK(sce_allowed(project_id));
GRANT SELECT ON delta_retention_floors TO sce_app;

CREATE FUNCTION sce_prune_memories(target_repo uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE w repository_watches%ROWTYPE; n integer; floor_time timestamptz; floor_key text; eid uuid; payload jsonb;
BEGIN
  SELECT * INTO w FROM repository_watches WHERE repo_id=target_repo;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF nullif(current_setting('sce.subject',true),'') IS NOT NULL THEN
    IF NOT (sce_allowed(w.project_id,target_repo) AND EXISTS(
      SELECT 1 FROM memberships m WHERE m.project_id=w.project_id AND m.subject=current_setting('sce.subject',true) AND 'write'=ANY(m.permissions)
    )) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  ELSIF NOT pg_has_role(session_user,'sce_retention','member') THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(w.project_id::text,0));
  WITH ranked AS (
    SELECT id,occurred_at,source_key,
      row_number() OVER (ORDER BY occurred_at DESC,source_key DESC) AS position,
      sum(content_bytes) OVER (ORDER BY occurred_at DESC,source_key DESC ROWS UNBOUNDED PRECEDING) AS running_bytes
    FROM session_memories WHERE repo_id=target_repo
  ), removed AS (
    DELETE FROM session_memories sm USING ranked r WHERE sm.id=r.id AND (
      r.occurred_at<now()-make_interval(days=>w.history_days) OR r.position>w.max_memories OR r.running_bytes>w.max_memory_bytes
    ) RETURNING sm.occurred_at,sm.source_key
  ) SELECT (SELECT count(*)::int FROM removed),
    (SELECT occurred_at FROM removed ORDER BY occurred_at DESC,source_key DESC LIMIT 1),
    (SELECT source_key FROM removed ORDER BY occurred_at DESC,source_key DESC LIMIT 1)
    INTO n,floor_time,floor_key;
  UPDATE repository_watches SET last_retention_at=now(),
    memory_pruned_at=CASE WHEN floor_time IS NOT NULL AND (memory_pruned_at IS NULL OR (floor_time,floor_key)>(memory_pruned_at,memory_pruned_key)) THEN floor_time ELSE memory_pruned_at END,
    memory_pruned_key=CASE WHEN floor_time IS NOT NULL AND (memory_pruned_at IS NULL OR (floor_time,floor_key)>(memory_pruned_at,memory_pruned_key)) THEN floor_key ELSE memory_pruned_key END
    WHERE repo_id=target_repo;
  IF n>0 THEN
    payload:=jsonb_build_object('repositoryId',target_repo,'removedMemories',n,'reason','retention');
    INSERT INTO context_events(project_id,repo_id,event_type,idempotency_key,payload)
      VALUES(w.project_id,target_repo,'context.retention.pruned','retention:'||gen_random_uuid()::text,payload) RETURNING id INTO eid;
    INSERT INTO outbox_events(project_id,repo_id,event_id,event_type,payload)
      VALUES(w.project_id,target_repo,eid,'context.retention.pruned',payload);
  END IF;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION sce_prune_memories(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sce_prune_memories(uuid) TO sce_app,sce_retention;
