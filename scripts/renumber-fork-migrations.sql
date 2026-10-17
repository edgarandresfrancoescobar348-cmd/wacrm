-- ============================================================
-- renumber-fork-migrations.sql — for a database that applied this fork's
-- WhatsApp migrations under their OLD numbers (047–076)
--
-- Upstream wacrm shipped its own 047–059 after the fork had used those
-- numbers. The fork's migrations now live at 060–089 (same order, same
-- content). A database that applied them as 047–076 still records them
-- under the old versions in supabase_migrations.schema_migrations, so the
-- Supabase CLI would think upstream's 047, 048, 049, 051–054 and 059 were
-- already applied (same version) and skip them, and would try to apply
-- 060–089 again.
--
-- This moves each recorded row to its new version — matched on BOTH the
-- old version AND the migration name, so upstream's own 047–059 rows (on
-- a database that has them) are never touched. Nothing else changes: no
-- schema, no data. Run it once before `supabase migration up`; running it
-- again does nothing (the old (version, name) pairs are gone).
--
--   supabase db query --file scripts/renumber-fork-migrations.sql
--   (or: psql "$DATABASE_URL" -f scripts/renumber-fork-migrations.sql)
--
-- then:
--
--   supabase migration up --include-all
--
-- (--include-all: upstream's 047–059 sort BEFORE the last applied
-- migration, 089, and the CLI refuses to apply out-of-order files without
-- it.) One statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement.
-- ============================================================

DO $$
DECLARE
  moved INTEGER := 0;
  kept INTEGER := 0;
  r RECORD;
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'supabase_migrations.schema_migrations not found — is this the right database?';
  END IF;

  CREATE TEMP TABLE fork_migration_map (old_version TEXT, new_version TEXT, name TEXT) ON COMMIT DROP;
  INSERT INTO fork_migration_map VALUES
    ('047', '060', 'whatsapp_openwa'),
    ('048', '061', 'openwa_delivery_state'),
    ('049', '062', 'openwa_replay_guards'),
    ('050', '063', 'message_status_pending'),
    ('051', '064', 'definer_search_path'),
    ('052', '065', 'apply_message_receipt'),
    ('053', '066', 'inbound_completion'),
    ('054', '067', 'broadcast_send_checkpoint'),
    ('055', '068', 'broadcast_params_jsonb'),
    ('056', '069', 'broadcast_send_attempts'),
    ('057', '070', 'inbound_fanout_outbox'),
    ('058', '071', 'openwa_status_mirror'),
    ('059', '072', 'send_evidence'),
    ('060', '073', 'fanout_outcomes'),
    ('061', '074', 'connection_lock'),
    ('062', '075', 'message_content_meta'),
    ('063', '076', 'whatsapp_history_import'),
    ('064', '077', 'openwa_embedded_gateway'),
    ('065', '078', 'history_import_empty_conversations'),
    ('066', '079', 'history_media'),
    ('067', '080', 'whatsapp_parity'),
    ('068', '081', 'whatsapp_list_parity'),
    ('069', '082', 'whatsapp_chat_order'),
    ('070', '083', 'whatsapp_untimed_chats'),
    ('071', '084', 'voice_preview_duration'),
    ('072', '085', 'whatsapp_connections'),
    ('073', '086', 'whatsapp_connection_visibility'),
    ('074', '087', 'broadcast_number_evidence'),
    ('075', '088', 'history_import_message_counts'),
    ('076', '089', 'whatsapp_connection_scope_change');

  -- A new version already taken by something else would be a database
  -- this script doesn't understand: stop before changing anything.
  FOR r IN
    SELECT m.new_version, s.name FROM fork_migration_map m
      JOIN supabase_migrations.schema_migrations s ON s.version = m.new_version
     WHERE s.name IS DISTINCT FROM m.name
       AND NOT EXISTS (SELECT 1 FROM fork_migration_map o
                        WHERE o.old_version = s.version AND o.name = s.name)
  LOOP
    RAISE EXCEPTION 'version % is already recorded as "%", not as this fork''s migration — nothing was changed', r.new_version, r.name;
  END LOOP;

  -- Two steps, so moving 047 → 060 never collides with the old 060 that
  -- is about to move to 073.
  UPDATE supabase_migrations.schema_migrations s
     SET version = 'renumber:' || m.new_version
    FROM fork_migration_map m
   WHERE s.version = m.old_version AND s.name = m.name;
  GET DIAGNOSTICS moved = ROW_COUNT;

  UPDATE supabase_migrations.schema_migrations
     SET version = substr(version, length('renumber:') + 1)
   WHERE version LIKE 'renumber:%';

  SELECT count(*) INTO kept FROM supabase_migrations.schema_migrations s
    JOIN fork_migration_map m ON s.version = m.new_version AND s.name = m.name;

  RAISE NOTICE 'renumbered % fork migration(s); % of 30 now recorded under 060–089', moved, kept;
END
$$;
