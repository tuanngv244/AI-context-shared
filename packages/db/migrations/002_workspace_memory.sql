CREATE TABLE organization_memberships (
  org_id uuid NOT NULL REFERENCES organizations(id),
  subject text NOT NULL,
  role text NOT NULL CHECK(role IN ('admin','member')),
  PRIMARY KEY(org_id,subject)
);
ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_member_identity ON organization_memberships USING (
  org_id::text=current_setting('sce.org_id',true) AND subject=current_setting('sce.subject',true)
);
GRANT SELECT ON organization_memberships TO sce_app;

CREATE TABLE repository_watches (
  repo_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  name text NOT NULL,
  local_path text,
  enabled boolean NOT NULL DEFAULT true,
  history_days integer NOT NULL DEFAULT 30 CHECK(history_days BETWEEN 1 AND 3650),
  last_scan_at timestamptz,
  last_capture_at timestamptz,
  observer_status text NOT NULL DEFAULT 'waiting',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,name),
  FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
  FOREIGN KEY(project_id,repo_id) REFERENCES repositories(project_id,id)
);
ALTER TABLE repository_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE repository_watches FORCE ROW LEVEL SECURITY;
CREATE POLICY watch_scope ON repository_watches USING(sce_allowed(project_id,repo_id)) WITH CHECK(sce_allowed(project_id,repo_id));
GRANT SELECT,UPDATE ON repository_watches TO sce_app;

CREATE TABLE session_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  repo_id uuid NOT NULL,
  session_id uuid NOT NULL,
  source_key text NOT NULL,
  summary text NOT NULL,
  pending_work jsonb NOT NULL DEFAULT '[]',
  blockers jsonb NOT NULL DEFAULT '[]',
  branch text,
  commit_sha text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('simple',summary)) STORED,
  UNIQUE(repo_id,source_key),
  FOREIGN KEY(project_id,repo_id) REFERENCES repositories(project_id,id),
  FOREIGN KEY(project_id,session_id) REFERENCES sessions(project_id,id)
);
ALTER TABLE session_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_memories FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_scope ON session_memories USING(sce_allowed(project_id,repo_id)) WITH CHECK(sce_allowed(project_id,repo_id));
GRANT SELECT,INSERT ON session_memories TO sce_app;
CREATE INDEX memory_timeline_idx ON session_memories(project_id,repo_id,occurred_at DESC);
CREATE INDEX memory_search_idx ON session_memories USING gin(search_document);

CREATE TABLE observer_offsets (
  source_hash text PRIMARY KEY,
  byte_offset bigint NOT NULL DEFAULT 0,
  skipping_line boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Local host observer uses the admin connection, never exposed through MCP or REST.
REVOKE ALL ON observer_offsets FROM PUBLIC;

CREATE FUNCTION sce_watch_repository(repo_name text, repo_remote text, repo_path text, repo_branch text, days integer)
RETURNS TABLE(project_id uuid,repo_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE oid uuid; pid uuid; rid uuid; actor text;
BEGIN
  oid := nullif(current_setting('sce.org_id',true),'')::uuid;
  actor := current_setting('sce.subject',true);
  IF NOT EXISTS(SELECT 1 FROM organization_memberships m WHERE m.org_id=oid AND m.subject=actor AND m.role='admin') THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(oid::text || ':' || repo_name,0));
  SELECT w.project_id,w.repo_id INTO pid,rid FROM repository_watches w WHERE w.org_id=oid AND w.name=repo_name;
  IF rid IS NOT NULL THEN
    IF NOT sce_allowed(pid,rid) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    RETURN QUERY SELECT pid,rid;
    RETURN;
  END IF;
  SELECT r.project_id,r.id INTO pid,rid FROM repositories r JOIN projects p ON p.id=r.project_id
    WHERE p.org_id=oid AND r.remote_url=repo_remote ORDER BY r.id LIMIT 1;
  IF rid IS NOT NULL AND NOT sce_allowed(pid,rid) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF rid IS NOT NULL AND EXISTS(SELECT 1 FROM repository_watches w WHERE w.repo_id=rid) THEN
    RETURN QUERY SELECT pid,rid; RETURN;
  END IF;
  IF rid IS NULL THEN
    INSERT INTO projects(org_id,name) VALUES(oid,repo_name) RETURNING id INTO pid;
    INSERT INTO memberships(org_id,project_id,subject,permissions) VALUES(oid,pid,actor,ARRAY['read','write','coordinate']);
    INSERT INTO repositories(project_id,remote_url,default_branch) VALUES(pid,repo_remote,repo_branch) RETURNING id INTO rid;
  END IF;
  INSERT INTO repository_watches(repo_id,project_id,org_id,name,local_path,history_days)
    VALUES(rid,pid,oid,repo_name,repo_path,days);
  INSERT INTO audit_logs(project_id,subject,action) VALUES(pid,actor,'repository.watch.added');
  RETURN QUERY SELECT pid,rid;
END;
$$;
REVOKE ALL ON FUNCTION sce_watch_repository(text,text,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sce_watch_repository(text,text,text,text,integer) TO sce_app;
