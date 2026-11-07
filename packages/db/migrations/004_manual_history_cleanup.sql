CREATE FUNCTION sce_clear_old_memories(target_repo uuid, older_than_days integer, dry_run boolean, requested_cutoff timestamptz DEFAULT NULL)
RETURNS TABLE(eligible_count bigint,eligible_bytes bigint,cutoff timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE w repository_watches%ROWTYPE; count_removed bigint; bytes_removed bigint; cutoff_time timestamptz;
  floor_time timestamptz; floor_key text; eid uuid; data jsonb;
BEGIN
  IF older_than_days<1 OR older_than_days>3650 THEN RAISE EXCEPTION 'Invalid history window' USING ERRCODE='22023'; END IF;
  SELECT * INTO w FROM repository_watches WHERE repo_id=target_repo;
  IF NOT FOUND OR NOT sce_allowed(w.project_id,target_repo) OR NOT EXISTS(
    SELECT 1 FROM organization_memberships m WHERE m.org_id=w.org_id AND m.subject=current_setting('sce.subject',true) AND m.role='admin'
  ) OR NOT EXISTS(
    SELECT 1 FROM memberships m WHERE m.project_id=w.project_id AND m.subject=current_setting('sce.subject',true) AND 'write'=ANY(m.permissions)
  ) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(w.project_id::text,0));
  cutoff_time:=COALESCE(requested_cutoff,now()-make_interval(days=>older_than_days));
  IF cutoff_time>now()-make_interval(days=>older_than_days) THEN RAISE EXCEPTION 'Invalid cleanup cutoff' USING ERRCODE='22023'; END IF;
  IF dry_run THEN
    RETURN QUERY SELECT count(*),coalesce(sum(sm.content_bytes),0)::bigint,cutoff_time
      FROM session_memories sm WHERE sm.repo_id=target_repo AND sm.occurred_at<cutoff_time;
    RETURN;
  END IF;
  WITH removed AS (
    DELETE FROM session_memories sm WHERE sm.repo_id=target_repo AND sm.occurred_at<cutoff_time
    RETURNING sm.content_bytes,sm.occurred_at,sm.source_key
  ) SELECT (SELECT count(*) FROM removed),(SELECT coalesce(sum(content_bytes),0)::bigint FROM removed),
      (SELECT occurred_at FROM removed ORDER BY occurred_at DESC,source_key DESC LIMIT 1),
      (SELECT source_key FROM removed ORDER BY occurred_at DESC,source_key DESC LIMIT 1)
    INTO count_removed,bytes_removed,floor_time,floor_key;
  -- A manual clear is a cutoff fence, including older messages not imported yet.
  floor_time:=cutoff_time; floor_key:='';
  UPDATE repository_watches SET
      memory_pruned_at=CASE WHEN memory_pruned_at IS NULL OR (floor_time,floor_key)>(memory_pruned_at,memory_pruned_key) THEN floor_time ELSE memory_pruned_at END,
      memory_pruned_key=CASE WHEN memory_pruned_at IS NULL OR (floor_time,floor_key)>(memory_pruned_at,memory_pruned_key) THEN floor_key ELSE memory_pruned_key END
      WHERE repo_id=target_repo;
  IF count_removed>0 THEN
    data:=jsonb_build_object('repositoryId',target_repo,'removedMemories',count_removed,'reason','manual_history_cleanup');
    INSERT INTO context_events(project_id,repo_id,event_type,idempotency_key,payload)
      VALUES(w.project_id,target_repo,'context.retention.pruned','cleanup:'||gen_random_uuid()::text,data) RETURNING id INTO eid;
    INSERT INTO outbox_events(project_id,repo_id,event_id,event_type,payload)
      VALUES(w.project_id,target_repo,eid,'context.retention.pruned',data);
  END IF;
  INSERT INTO audit_logs(project_id,subject,action) VALUES(w.project_id,current_setting('sce.subject',true),'repository.history.cleared');
  RETURN QUERY SELECT count_removed,bytes_removed,cutoff_time;
END;
$$;
REVOKE ALL ON FUNCTION sce_clear_old_memories(uuid,integer,boolean,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sce_clear_old_memories(uuid,integer,boolean,timestamptz) TO sce_app;
