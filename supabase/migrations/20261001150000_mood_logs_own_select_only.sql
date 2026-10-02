-- KI-21: camera-derived mood rows were SELECT-able by the partner. No client code,
-- edge function or realtime subscription reads the partner's rows (audited 2026-10-01);
-- the partner-visible mood lives on profiles and only after the owner confirms it.
DROP POLICY IF EXISTS "View own and partner mood logs" ON public.mood_logs;
DROP POLICY IF EXISTS "View own mood logs" ON public.mood_logs;
CREATE POLICY "View own mood logs" ON public.mood_logs
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
