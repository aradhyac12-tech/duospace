-- Applied live 2026-09-21 (performance advisor 0003): evaluate auth.uid() once per statement, not per row.
DROP POLICY IF EXISTS "View own unlink requests" ON public.unlink_requests;
CREATE POLICY "View own unlink requests" ON public.unlink_requests
  FOR SELECT TO authenticated
  USING (requester_id = (SELECT auth.uid()) OR partner_id = (SELECT auth.uid()));
