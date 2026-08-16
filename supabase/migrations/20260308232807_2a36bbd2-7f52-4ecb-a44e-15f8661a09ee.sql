
-- Allow users to delete their own call history
CREATE POLICY "Users can delete own calls"
ON public.call_history
FOR DELETE
TO authenticated
USING (auth.uid() = caller_id OR auth.uid() = receiver_id);
