/*
  # Fix RLS Infinite Recursion

  ## Problem
  - Infinite recursion in agents table RLS policies
  - Signup and login not working

  ## Solution
  - Drop all existing agents RLS policies
  - Recreate simple, non-recursive policies
  - Ensure trigger bypasses RLS with SECURITY DEFINER
*/

-- Drop ALL existing policies on agents table
DROP POLICY IF EXISTS "Agents can view all agents" ON agents;
DROP POLICY IF EXISTS "Agents can update own profile" ON agents;
DROP POLICY IF EXISTS "Users can create own agent profile" ON agents;

-- Recreate simple SELECT policy
CREATE POLICY "Allow authenticated users to view agents"
  ON agents FOR SELECT
  TO authenticated
  USING (true);

-- Recreate UPDATE policy (only own profile)
CREATE POLICY "Allow agents to update own profile"
  ON agents FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- NO INSERT policy - trigger will handle inserts with SECURITY DEFINER