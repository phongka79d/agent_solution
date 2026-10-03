-- Tenant-scoped knowledge documents, immutable revisions, and an append-only lifecycle history.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_indexer') THEN
    CREATE ROLE agentos_indexer NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;
ALTER ROLE agentos_indexer NOLOGIN NOBYPASSRLS;

CREATE TABLE agentos.knowledge_documents (
  tenant_id UUID NOT NULL REFERENCES agentos.tenants (tenant_id) ON DELETE RESTRICT,
  document_id UUID NOT NULL DEFAULT agentos.uuid_generate_v7(),
  namespace TEXT NOT NULL CHECK (namespace IN ('company', 'product', 'brand', 'marketing', 'sales', 'customer-care', 'policy')),
  document_type TEXT NOT NULL CHECK (document_type IN ('FAQ', 'SHIPPING', 'RETURNS', 'WARRANTY', 'BRAND_VOICE', 'SALES_GUIDELINE', 'MARKETING_GUIDELINE', 'AUTHORITY_POLICY')),
  slug TEXT NOT NULL CHECK (slug <> '' AND slug = pg_catalog.btrim(slug)),
  current_version BIGINT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'REVIEW', 'APPROVED', 'AVAILABLE', 'ARCHIVED')),
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, document_id)
);

CREATE TABLE agentos.knowledge_document_versions (
  tenant_id UUID NOT NULL,
  document_id UUID NOT NULL,
  version BIGINT NOT NULL CHECK (version > 0),
  namespace TEXT NOT NULL CHECK (namespace IN ('company', 'product', 'brand', 'marketing', 'sales', 'customer-care', 'policy')),
  document_type TEXT NOT NULL CHECK (document_type IN ('FAQ', 'SHIPPING', 'RETURNS', 'WARRANTY', 'BRAND_VOICE', 'SALES_GUIDELINE', 'MARKETING_GUIDELINE', 'AUTHORITY_POLICY')),
  slug TEXT NOT NULL CHECK (slug <> '' AND slug = pg_catalog.btrim(slug)),
  title TEXT NOT NULL CHECK (title <> '' AND title = pg_catalog.btrim(title)),
  body TEXT NOT NULL,
  content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  data_class agentos.data_class NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, document_id, version),
  FOREIGN KEY (tenant_id, document_id)
    REFERENCES agentos.knowledge_documents (tenant_id, document_id)
    ON DELETE RESTRICT,
  CHECK (content_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(body, 'UTF8')), 'hex'))
);
CREATE FUNCTION agentos.knowledge_document_version_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, agentos, pg_temp
AS $$
DECLARE
  v_current_version BIGINT;
  v_tenant_data_class agentos.data_class;
BEGIN
  SELECT d.current_version, t.data_class
    INTO v_current_version, v_tenant_data_class
    FROM agentos.knowledge_documents AS d
    JOIN agentos.tenants AS t ON t.tenant_id = d.tenant_id
   WHERE d.tenant_id = NEW.tenant_id AND d.document_id = NEW.document_id
   FOR UPDATE OF d;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge document tenant binding is missing' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> COALESCE(v_current_version, 0) + 1 THEN
    RAISE EXCEPTION 'knowledge versions must be appended in order' USING ERRCODE = '23514';
  END IF;
  IF NEW.data_class IS DISTINCT FROM v_tenant_data_class THEN
    RAISE EXCEPTION 'knowledge version data_class must match its tenant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION agentos.knowledge_document_version_guard() FROM PUBLIC;
CREATE TRIGGER knowledge_document_version_guard
  BEFORE INSERT ON agentos.knowledge_document_versions
  FOR EACH ROW EXECUTE FUNCTION agentos.knowledge_document_version_guard();


ALTER TABLE agentos.knowledge_documents
  ADD CONSTRAINT knowledge_documents_current_version_fk
  FOREIGN KEY (tenant_id, document_id, current_version)
  REFERENCES agentos.knowledge_document_versions (tenant_id, document_id, version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE agentos.knowledge_document_events (
  tenant_id UUID NOT NULL,
  event_id UUID NOT NULL DEFAULT agentos.uuid_generate_v7(),
  document_id UUID NOT NULL,
  version BIGINT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'SUBMIT', 'APPROVE', 'REJECT', 'ARCHIVE', 'MAKE_AVAILABLE')),
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('DRAFT', 'REVIEW', 'APPROVED', 'AVAILABLE', 'ARCHIVED')),
  to_status TEXT NOT NULL CHECK (to_status IN ('DRAFT', 'REVIEW', 'APPROVED', 'AVAILABLE', 'ARCHIVED')),
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, document_id, version)
    REFERENCES agentos.knowledge_document_versions (tenant_id, document_id, version)
    ON DELETE RESTRICT
);

CREATE INDEX knowledge_documents_status_idx
  ON agentos.knowledge_documents (tenant_id, namespace, status, created_at DESC, document_id DESC);
CREATE UNIQUE INDEX knowledge_documents_live_slug_idx
  ON agentos.knowledge_documents (tenant_id, namespace, slug)
  WHERE status <> 'ARCHIVED';
CREATE INDEX knowledge_document_versions_history_idx
  ON agentos.knowledge_document_versions (tenant_id, document_id, version DESC);
CREATE INDEX knowledge_document_events_history_idx
  ON agentos.knowledge_document_events (tenant_id, document_id, occurred_at DESC, event_id DESC);

CREATE FUNCTION agentos.knowledge_reject_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, agentos, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = '23514';
END
$$;
REVOKE ALL ON FUNCTION agentos.knowledge_reject_immutable_mutation() FROM PUBLIC;
CREATE TRIGGER knowledge_document_versions_immutable
  BEFORE UPDATE OR DELETE ON agentos.knowledge_document_versions
  FOR EACH ROW EXECUTE FUNCTION agentos.knowledge_reject_immutable_mutation();
CREATE TRIGGER knowledge_document_events_immutable
  BEFORE UPDATE OR DELETE ON agentos.knowledge_document_events
  FOR EACH ROW EXECUTE FUNCTION agentos.knowledge_reject_immutable_mutation();

CREATE FUNCTION agentos.knowledge_document_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, agentos, pg_temp
AS $$
DECLARE
  v_distinct_approver BOOLEAN;
  v_version_author TEXT;
  v_version_namespace TEXT;
  v_version_type TEXT;
  v_version_slug TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.current_version IS NOT NULL OR NEW.approved_by IS NOT NULL THEN
      RAISE EXCEPTION 'knowledge documents must be created as a draft without a current version' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.current_version IS DISTINCT FROM OLD.current_version THEN
    IF NEW.current_version IS NULL
      OR (OLD.current_version IS NOT NULL AND NEW.current_version <= OLD.current_version)
      OR NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'a new knowledge version must advance and reset to draft' USING ERRCODE = '23514';
    END IF;
    SELECT v.namespace, v.document_type, v.slug
      INTO v_version_namespace, v_version_type, v_version_slug
      FROM agentos.knowledge_document_versions AS v
     WHERE v.tenant_id = NEW.tenant_id AND v.document_id = NEW.document_id
       AND v.version = NEW.current_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'knowledge document version does not exist' USING ERRCODE = '23514';
    END IF;
    IF NEW.namespace IS DISTINCT FROM v_version_namespace
      OR NEW.document_type IS DISTINCT FROM v_version_type
      OR NEW.slug IS DISTINCT FROM v_version_slug THEN
      RAISE EXCEPTION 'knowledge document metadata must match its current version' USING ERRCODE = '23514';
    END IF;
    NEW.approved_by := NULL;
  ELSIF NEW.namespace IS DISTINCT FROM OLD.namespace
    OR NEW.document_type IS DISTINCT FROM OLD.document_type
    OR NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'knowledge document metadata changes require a new version' USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'ARCHIVED' THEN
      NULL;
    ELSIF NEW.current_version IS DISTINCT FROM OLD.current_version AND NEW.status = 'DRAFT' THEN
      NULL;
    ELSIF OLD.status = 'DRAFT' AND NEW.status = 'REVIEW' THEN
      NULL;
    ELSIF OLD.status = 'REVIEW' AND NEW.status IN ('DRAFT', 'APPROVED') THEN
      IF NEW.status = 'APPROVED' THEN
        SELECT COALESCE(g.require_distinct_approver, TRUE), v.created_by
          INTO v_distinct_approver, v_version_author
          FROM agentos.knowledge_document_versions AS v
          LEFT JOIN agentos.tenant_governance_settings AS g ON g.tenant_id = v.tenant_id
         WHERE v.tenant_id = NEW.tenant_id AND v.document_id = NEW.document_id
           AND v.version = NEW.current_version;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'knowledge document current version does not exist' USING ERRCODE = '23514';
        END IF;
        IF NEW.approved_by IS NULL OR NEW.approved_by = '' THEN
          RAISE EXCEPTION 'knowledge approval requires approver identity' USING ERRCODE = '23514';
        END IF;
        IF v_distinct_approver AND NEW.approved_by = v_version_author THEN
          RAISE EXCEPTION 'knowledge approval requires a distinct approver' USING ERRCODE = '23514';
        END IF;
      END IF;
    ELSIF OLD.status = 'APPROVED' AND NEW.status = 'AVAILABLE' THEN
      IF CURRENT_USER <> 'agentos_indexer' THEN
        RAISE EXCEPTION 'only the knowledge indexer may mark a document available' USING ERRCODE = '42501';
      END IF;
    ELSE
      RAISE EXCEPTION 'invalid knowledge document status transition: % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'knowledge approver changes require an approval transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION agentos.knowledge_document_status_transition() FROM PUBLIC;
CREATE TRIGGER knowledge_document_status_transition
  BEFORE UPDATE OF status, current_version, approved_by, namespace, document_type, slug ON agentos.knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION agentos.knowledge_document_status_transition();

SELECT agentos.apply_tenant_rls('agentos.knowledge_documents');
SELECT agentos.apply_tenant_rls('agentos.knowledge_document_versions');
SELECT agentos.apply_tenant_rls('agentos.knowledge_document_events');

GRANT SELECT, INSERT, UPDATE ON agentos.knowledge_documents TO agentos_app;
REVOKE DELETE, TRUNCATE ON agentos.knowledge_documents FROM agentos_app;
GRANT SELECT, INSERT ON agentos.knowledge_document_versions TO agentos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON agentos.knowledge_document_versions FROM agentos_app;
GRANT SELECT, INSERT ON agentos.knowledge_document_events TO agentos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON agentos.knowledge_document_events FROM agentos_app;

GRANT SELECT ON agentos.knowledge_documents, agentos.knowledge_document_versions TO agentos_indexer;
GRANT UPDATE (status, updated_at) ON agentos.knowledge_documents TO agentos_indexer;
GRANT SELECT, INSERT ON agentos.knowledge_document_events TO agentos_indexer;
REVOKE UPDATE, DELETE, TRUNCATE ON agentos.knowledge_document_events FROM agentos_indexer;
GRANT USAGE ON SCHEMA agentos TO agentos_indexer;
GRANT EXECUTE ON FUNCTION agentos.platform_append_audit(TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT)
  TO agentos_indexer;

