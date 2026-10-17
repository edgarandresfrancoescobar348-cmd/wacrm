-- ============================================================
-- 068_broadcast_params_jsonb — per-recipient params that survive the
--     trip through PostgREST
--
-- The problem
--
--   POST /api/v1/broadcasts with `params` on its recipients answered 500
--   and left a broken campaign behind. create_broadcast_with_recipients
--   took the frozen params as `p_template_params JSONB[]` — one JSONB per
--   recipient, each itself an array like ["Ana","#123"]. PostgREST turns
--   a JSON array of arrays into a MULTI-dimensional Postgres array, so
--   the function received {{"Ana","#123"}} — a 2-D jsonb[] of strings.
--   `unnest(p_contact_ids, p_template_params)` flattens that to one row
--   per STRING, pads the contact side with NULL, and inserted extra
--   recipients with contact_id NULL; the app then failed pairing the
--   returned rows back to its recipients. With no params at all ([[]])
--   the array is empty and it happened to work, which is why it went
--   unnoticed.
--
-- The fix
--
--   The parameter becomes a single JSONB: a JSON array whose i-th
--   element is recipient i's params (any JSON; normally an array of
--   strings). Paired with p_contact_ids by ordinality, LEFT JOINed so a
--   shorter params list still pads with NULL ("no params" to the resume
--   path, as before). The app already sends exactly that JSON — no app,
--   wizard, resume or MCP change is needed; only the type the database
--   declares.
--
--   The old JSONB[] signature is dropped (two overloads with the same
--   argument names would make PostgREST's resolution ambiguous). Result
--   columns and the qualified RETURNING (041) are unchanged.
--
-- Idempotent.
-- ============================================================

DROP FUNCTION IF EXISTS public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]);

CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id        UUID,
  p_user_id           UUID,
  p_name              TEXT,
  p_template_name     TEXT,
  p_template_language TEXT,
  p_total_recipients  INTEGER,
  p_contact_ids       UUID[],
  p_template_params   JSONB
)
RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_broadcast_id UUID;
  v_params JSONB := COALESCE(p_template_params, '[]'::jsonb);
BEGIN
  IF jsonb_typeof(v_params) <> 'array' THEN
    RAISE EXCEPTION 'p_template_params must be a JSON array (one element per contact)'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.broadcasts (
    account_id, user_id, name, template_name,
    template_language, status, total_recipients
  )
  VALUES (
    p_account_id, p_user_id, p_name, p_template_name,
    p_template_language, 'sending', p_total_recipients
  )
  RETURNING id INTO v_broadcast_id;

  RETURN QUERY
  WITH ins AS (
    INSERT INTO public.broadcast_recipients (
      broadcast_id, contact_id, status, template_params
    )
    SELECT v_broadcast_id, c.cid, 'pending', NULLIF(p.prm, 'null'::jsonb)
    FROM unnest(p_contact_ids) WITH ORDINALITY AS c(cid, i)
    LEFT JOIN jsonb_array_elements(v_params) WITH ORDINALITY AS p(prm, j)
      ON p.j = c.i
    ORDER BY c.i
    -- Qualified: a bare `contact_id` collides with the RETURNS TABLE
    -- output variable of the same name (041).
    RETURNING id, broadcast_recipients.contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB) TO service_role;

-- PostgREST caches function signatures; pick up the new one.
NOTIFY pgrst, 'reload schema';
