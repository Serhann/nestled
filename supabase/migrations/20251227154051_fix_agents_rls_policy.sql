/*
  # Fix Agents Table RLS Policy

  ## Changes
  - Add INSERT policy for agents table to allow user registration
  - Users can create their own agent profile during signup

  ## Security
  - Users can only insert their own profile (id = auth.uid())
*/

-- Add INSERT policy for agents
CREATE POLICY "Users can create own agent profile"
  ON agents FOR INSERT
  TO authenticated
  WITH CHECK (id = auth.uid());