/*
  # Allow Manual Agent Creation

  ## Changes
  - Add INSERT policy for agents table to allow manual agent creation
  - This handles cases where:
    1. The trigger hasn't completed yet
    2. Existing users don't have agent records
    3. Manual recovery is needed

  ## Security
  - Users can only insert their own agent record (id must match auth.uid())
  - Name and email can be set during creation
*/

-- Add INSERT policy for agents table
CREATE POLICY "Allow users to create own agent profile"
  ON agents FOR INSERT
  TO authenticated
  WITH CHECK (id = auth.uid());
