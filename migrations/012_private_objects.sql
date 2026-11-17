-- Private originals stored in PostgreSQL (alternative to S3-compatible storage).
-- Content-addressed and immutable; size-capped per object and per publisher by the application.
BEGIN;
CREATE TABLE IF NOT EXISTS ask_bill.private_objects (
 publisher_id uuid NOT NULL REFERENCES ask_bill.publishers(id) ON DELETE RESTRICT,
 scope text NOT NULL CHECK(scope IN ('quarantine','private-source')),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 mime text NOT NULL CHECK(length(mime) BETWEEN 3 AND 120),
 size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 26214400),
 content bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(publisher_id,scope,sha256),
 CHECK(octet_length(content)=size_bytes)
);
DO $objects$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='ask_bill' AND tablename='private_objects' AND policyname='publisher_scope') THEN
  CREATE POLICY publisher_scope ON ask_bill.private_objects FOR ALL USING (publisher_id=ask_bill.current_publisher_id()) WITH CHECK (publisher_id=ask_bill.current_publisher_id());
 END IF;
END $objects$;
ALTER TABLE ask_bill.private_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE ask_bill.private_objects FORCE ROW LEVEL SECURITY;
-- Source objects are immutable once stored; only quarantine rows may be deleted after promotion.
CREATE OR REPLACE FUNCTION ask_bill.reject_private_object_change() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND OLD.scope='quarantine' THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Private source objects are immutable' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION ask_bill.reject_private_object_change() FROM PUBLIC;
DO $immutable$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='private_objects_immutable' AND tgrelid='ask_bill.private_objects'::regclass) THEN
  CREATE TRIGGER private_objects_immutable BEFORE UPDATE OR DELETE ON ask_bill.private_objects FOR EACH ROW EXECUTE FUNCTION ask_bill.reject_private_object_change();
 END IF;
END $immutable$;
COMMIT;
