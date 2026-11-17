-- Built-in publisher passkeys (WebAuthn) as an alternative to OIDC.
-- Invites are created only by the owner role (maintenance CLI). The runtime role can read an
-- invite's existence and redeem it solely through ask_bill.redeem_publisher_invite, which
-- atomically enrolls the identity + passkey for the invite's pre-existing membership.
BEGIN;
CREATE TABLE IF NOT EXISTS ask_bill.publisher_enrollment_invites (
 publisher_id uuid NOT NULL,
 invite_sha256 text NOT NULL CHECK(invite_sha256 ~ '^[a-f0-9]{64}$'),
 user_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL CHECK(expires_at>created_at),
 redeemed_at timestamptz,
 redeemed_identity_sha256 text CHECK(redeemed_identity_sha256 IS NULL OR redeemed_identity_sha256 ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(publisher_id,invite_sha256),
 FOREIGN KEY(publisher_id,user_id) REFERENCES ask_bill.publisher_memberships(publisher_id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS ask_bill.publisher_passkeys (
 publisher_id uuid NOT NULL,
 credential_id text NOT NULL CHECK(credential_id ~ '^[A-Za-z0-9_-]+$' AND length(credential_id) BETWEEN 16 AND 1366),
 identity_sha256 text NOT NULL CHECK(identity_sha256 ~ '^[a-f0-9]{64}$'),
 user_id uuid NOT NULL,
 public_key_spki bytea NOT NULL CHECK(octet_length(public_key_spki) BETWEEN 32 AND 2048),
 algorithm integer NOT NULL CHECK(algorithm IN (-7,-8,-257)),
 sign_count bigint NOT NULL DEFAULT 0 CHECK(sign_count>=0),
 transports text[] NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 last_used_at timestamptz,
 PRIMARY KEY(publisher_id,credential_id),
 UNIQUE(publisher_id,identity_sha256),
 FOREIGN KEY(publisher_id,identity_sha256) REFERENCES ask_bill.publisher_auth_identities(publisher_id,identity_sha256) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS ask_bill.publisher_webauthn_challenges (
 publisher_id uuid NOT NULL REFERENCES ask_bill.publishers(id) ON DELETE CASCADE,
 challenge_sha256 text NOT NULL CHECK(challenge_sha256 ~ '^[a-f0-9]{64}$'),
 binding_sha256 text NOT NULL CHECK(binding_sha256 ~ '^[a-f0-9]{64}$'),
 purpose text NOT NULL CHECK(purpose IN ('register','login')),
 challenge text NOT NULL CHECK(challenge ~ '^[A-Za-z0-9_-]{43}$'),
 invite_sha256 text CHECK(invite_sha256 IS NULL OR invite_sha256 ~ '^[a-f0-9]{64}$'),
 return_path text NOT NULL DEFAULT '/admin' CHECK(length(return_path) BETWEEN 6 AND 1000),
 require_mfa boolean NOT NULL DEFAULT false,
 previous_session_sha256 text CHECK(previous_session_sha256 IS NULL OR previous_session_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
 PRIMARY KEY(publisher_id,challenge_sha256),
 CHECK((purpose='register')=(invite_sha256 IS NOT NULL))
);
DO $passkeys$
DECLARE tbl text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY['publisher_enrollment_invites','publisher_passkeys','publisher_webauthn_challenges'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='ask_bill' AND tablename=tbl AND policyname='publisher_scope') THEN
   EXECUTE format('CREATE POLICY publisher_scope ON ask_bill.%I FOR ALL USING (publisher_id=ask_bill.current_publisher_id()) WITH CHECK (publisher_id=ask_bill.current_publisher_id())',tbl);
  END IF;
  EXECUTE format('ALTER TABLE ask_bill.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE ask_bill.%I FORCE ROW LEVEL SECURITY',tbl);
 END LOOP;
END $passkeys$;

CREATE OR REPLACE FUNCTION ask_bill.redeem_publisher_invite(p_invite_sha256 text,p_identity_sha256 text,p_credential_id text,
  p_public_key_spki bytea,p_algorithm integer,p_sign_count bigint,p_transports text[])
RETURNS TABLE(user_id uuid,role text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope uuid:=ask_bill.current_publisher_id();invited uuid;
BEGIN
 IF scope IS NULL THEN RAISE EXCEPTION 'Publisher scope required' USING ERRCODE='42501'; END IF;
 UPDATE ask_bill.publisher_enrollment_invites i SET redeemed_at=clock_timestamp(),redeemed_identity_sha256=p_identity_sha256
  WHERE i.publisher_id=scope AND i.invite_sha256=p_invite_sha256 AND i.redeemed_at IS NULL AND i.expires_at>clock_timestamp()
  RETURNING i.user_id INTO invited;
 IF invited IS NULL THEN RETURN; END IF;
 INSERT INTO ask_bill.publisher_auth_identities(publisher_id,identity_sha256,user_id) VALUES(scope,p_identity_sha256,invited);
 INSERT INTO ask_bill.publisher_passkeys(publisher_id,credential_id,identity_sha256,user_id,public_key_spki,algorithm,sign_count,transports)
  VALUES(scope,p_credential_id,p_identity_sha256,invited,p_public_key_spki,p_algorithm,p_sign_count,coalesce(p_transports,'{}'));
 INSERT INTO ask_bill.audit_events(publisher_id,actor_user_id,action,detail)
  VALUES(scope,invited,'publisher.passkey_enrolled',jsonb_build_object('identitySha256',p_identity_sha256,'algorithm',p_algorithm));
 RETURN QUERY SELECT m.user_id,m.role FROM ask_bill.publisher_memberships m WHERE m.publisher_id=scope AND m.user_id=invited;
END $$;
REVOKE ALL ON FUNCTION ask_bill.redeem_publisher_invite(text,text,text,bytea,integer,bigint,text[]) FROM PUBLIC;
COMMIT;
