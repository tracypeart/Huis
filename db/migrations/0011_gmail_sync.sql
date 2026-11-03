-- Phase 3 part 3 (Gmail), independent review 7.
--
-- A fresh Gmail import (first sync, after Gmail's history expired, or after
-- choosing different labels) lists what is in the mailbox now; it can't see
-- what was trashed or deleted in the meantime. Each message records when a
-- sync last saw it, and when a fresh import finishes, anything it didn't see
-- is marked as removed from the mailbox.

ALTER TABLE huis.mail_messages ADD COLUMN sync_seen_at timestamptz;

CREATE OR REPLACE FUNCTION huis.worker_save_mail_messages(p_connection_id uuid, p_lock_token uuid, p_folder_id uuid, p_messages jsonb) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  c huis.mail_connections;
  n int := 0;
  r jsonb;
BEGIN
  c := huis.worker_held_mailbox(p_connection_id, p_lock_token);
  IF NOT EXISTS (SELECT 1 FROM huis.mail_folders WHERE id = p_folder_id AND connection_id = c.id) THEN
    RAISE EXCEPTION 'unknown folder';
  END IF;
  IF jsonb_typeof(p_messages) <> 'array' OR jsonb_array_length(p_messages) > 500 THEN RAISE EXCEPTION 'invalid batch'; END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_messages) LOOP
   BEGIN
    IF (r->>'removed')::boolean IS TRUE THEN
      UPDATE huis.mail_messages SET removed_at = coalesce(removed_at, now()), updated_at = now()
       WHERE connection_id = c.id AND provider_message_id = r->>'id';
    ELSE
      INSERT INTO huis.mail_messages (firm_id, connection_id, folder_id, provider_message_id, internet_message_id, conversation_id,
          subject, from_address, from_name, to_addresses, cc_addresses, received_at, sent_at, has_attachments, importance,
          is_read, preview, body_text, sync_seen_at)
        VALUES (c.firm_id, c.id, p_folder_id, left(r->>'id', 1000), left(r->>'internetMessageId', 1000), left(r->>'conversationId', 1000),
          left(r->>'subject', 1000), left(lower(r->>'fromAddress'), 320), left(r->>'fromName', 300),
          ARRAY(SELECT left(lower(x), 320) FROM jsonb_array_elements_text(coalesce(r->'to', '[]'::jsonb)) x LIMIT 500),
          ARRAY(SELECT left(lower(x), 320) FROM jsonb_array_elements_text(coalesce(r->'cc', '[]'::jsonb)) x LIMIT 500),
          (r->>'receivedAt')::timestamptz, (r->>'sentAt')::timestamptz, coalesce((r->>'hasAttachments')::boolean, false),
          left(r->>'importance', 20), (r->>'isRead')::boolean, left(r->>'preview', 1000), left(r->>'body', 1000000), now())
        ON CONFLICT (connection_id, provider_message_id) DO UPDATE
          SET folder_id = EXCLUDED.folder_id, subject = EXCLUDED.subject, is_read = EXCLUDED.is_read,
              preview = EXCLUDED.preview, body_text = EXCLUDED.body_text, removed_at = NULL, updated_at = now(),
              sync_seen_at = now();
    END IF;
    n := n + 1;
   EXCEPTION WHEN others THEN
    -- One malformed message (bad characters, impossible dates) is skipped;
    -- it must never stop the rest of the mailbox from syncing.
    NULL;
   END;
  END LOOP;
  RETURN n;
END $$;

-- Marks everything a finished fresh import didn't see as removed.
CREATE FUNCTION huis.worker_sweep_unseen_mail(p_connection_id uuid, p_lock_token uuid, p_import_started timestamptz) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = huis, pg_temp AS $$
DECLARE
  c huis.mail_connections;
  n int;
BEGIN
  c := huis.worker_held_mailbox(p_connection_id, p_lock_token);
  IF p_import_started IS NULL OR p_import_started > now() OR p_import_started < now() - interval '90 days' THEN
    RAISE EXCEPTION 'invalid import start';
  END IF;
  UPDATE huis.mail_messages SET removed_at = now(), updated_at = now()
   WHERE connection_id = c.id AND removed_at IS NULL AND (sync_seen_at IS NULL OR sync_seen_at < p_import_started);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
ALTER FUNCTION huis.worker_sweep_unseen_mail(uuid, uuid, timestamptz) OWNER TO huis_security;
REVOKE ALL ON FUNCTION huis.worker_sweep_unseen_mail(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION huis.worker_sweep_unseen_mail(uuid, uuid, timestamptz) TO huis_worker;
