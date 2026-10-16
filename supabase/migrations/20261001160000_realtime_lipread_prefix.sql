-- KI-23: allow the couple-scoped `lipread:<uid1>:<uid2>` broadcast topic (partner notice
-- while lip reading runs on their video). Only change vs 20260916150000: prefix allowlist.
CREATE OR REPLACE FUNCTION public.is_couple_realtime_topic_authorized(p_topic text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  parts text[];
  prefix text;
  uid1 uuid;
  uid2 uuid;
  other_uid uuid;
  my_partner uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;

  parts := string_to_array(p_topic, ':');
  IF array_length(parts, 1) <> 3 THEN
    RETURN false;
  END IF;

  prefix := parts[1];
  IF prefix NOT IN ('typing', 'presence', 'groic', 'blend-sync', 'lipread') THEN
    RETURN false;
  END IF;

  BEGIN
    uid1 := parts[2]::uuid;
    uid2 := parts[3]::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;

  IF auth.uid() = uid1 THEN
    other_uid := uid2;
  ELSIF auth.uid() = uid2 THEN
    other_uid := uid1;
  ELSE
    RETURN false;
  END IF;

  SELECT partner_id INTO my_partner FROM public.profiles WHERE user_id = auth.uid();
  RETURN my_partner IS NOT NULL AND my_partner = other_uid;
END;
$function$;
