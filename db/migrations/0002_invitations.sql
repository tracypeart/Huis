-- Huis Law IP — user invitations
--
-- Invited users are linked to their sign-in identity ONLY through a one-time
-- invitation link, never by matching the email address in a sign-in token.
-- Email claims from identity providers are not a safe account key (an
-- attacker can control the email shown in some tenants), so Huis never
-- links accounts by email.

SET search_path = huis, public;

CREATE TABLE huis.user_invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id      uuid NOT NULL REFERENCES huis.firms(id),
  user_id      uuid NOT NULL,
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  FOREIGN KEY (firm_id, user_id) REFERENCES huis.users(firm_id, id),
  FOREIGN KEY (firm_id, created_by) REFERENCES huis.users(firm_id, id)
);
CREATE INDEX user_invitations_user ON huis.user_invitations (user_id);

ALTER TABLE huis.user_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE huis.user_invitations FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON huis.user_invitations TO huis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON huis.user_invitations TO huis_security;

CREATE POLICY invitations_admin ON huis.user_invitations FOR ALL TO huis_app
  USING (firm_id = huis.current_firm_id() AND huis.is_admin_role(huis.app_role()))
  WITH CHECK (firm_id = huis.current_firm_id() AND huis.is_admin_role(huis.app_role())
              AND created_by = huis.current_user_id());

-- Accept an invitation: binds the signed-in identity to the invited account.
-- Works before any firm context exists. Returns nothing if the token is
-- unknown, used, revoked, expired, or the account is already linked.
CREATE FUNCTION huis.accept_invitation(p_token text, p_provider text, p_subject text)
RETURNS TABLE (firm_id uuid, user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, public, pg_temp AS $$
DECLARE
  v_inv huis.user_invitations;
BEGIN
  IF p_token IS NULL OR length(p_token) < 32 OR p_subject IS NULL OR p_provider IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO v_inv FROM huis.user_invitations i
   WHERE i.token_hash = encode(public.digest(p_token, 'sha256'), 'hex')
     AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- The account must still be active and not already linked to an identity,
  -- and this identity must not already hold another account in the firm.
  IF NOT EXISTS (SELECT 1 FROM huis.users u WHERE u.id = v_inv.user_id
                 AND u.status = 'active' AND u.auth_subject IS NULL)
     OR EXISTS (SELECT 1 FROM huis.users u WHERE u.firm_id = v_inv.firm_id
                AND u.auth_provider = p_provider AND u.auth_subject = p_subject) THEN
    RETURN;
  END IF;

  UPDATE huis.users SET auth_provider = p_provider, auth_subject = p_subject
   WHERE id = v_inv.user_id;
  UPDATE huis.user_invitations SET accepted_at = now() WHERE id = v_inv.id;
  INSERT INTO huis.audit_events (firm_id, actor_user_id, action, target_type, target_id)
    VALUES (v_inv.firm_id, v_inv.user_id, 'user.invitation_accepted', 'user', v_inv.user_id);

  RETURN QUERY SELECT v_inv.firm_id, v_inv.user_id;
END $$;

ALTER FUNCTION huis.accept_invitation(text, text, text) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.accept_invitation(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.accept_invitation(text, text, text) TO huis_app;
