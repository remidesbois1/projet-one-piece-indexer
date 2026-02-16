-- Helper functions to check permissions
-- These functions are SECURITY DEFINER to run with the privileges of the creator (postgres/admin)
-- ensuring they can access the profiles table even if RLS would otherwise block it (though profiles is public read)

CREATE OR REPLACE FUNCTION public.is_admin() 
RETURNS boolean 
LANGUAGE plpgsql 
SECURITY DEFINER 
SET search_path = public 
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 
    FROM public.profiles 
    WHERE id = auth.uid() 
    AND role = 'Admin'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_staff() 
RETURNS boolean 
LANGUAGE plpgsql 
SECURITY DEFINER 
SET search_path = public 
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 
    FROM public.profiles 
    WHERE id = auth.uid() 
    AND role IN ('Admin', 'Modo')
  );
END;
$$;

-- Enable RLS on all public tables

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.banned_ips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bubble_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bulles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chapitres ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.glossary ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mangas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tomes ENABLE ROW LEVEL SECURITY;

-- Clean up existing policies (to ensure idempotency)

DROP POLICY IF EXISTS "Public read access" ON public.app_settings;
DROP POLICY IF EXISTS "Admin write access" ON public.app_settings;

DROP POLICY IF EXISTS "Staff full access" ON public.banned_ips;

DROP POLICY IF EXISTS "Staff read access" ON public.bubble_history;
DROP POLICY IF EXISTS "Users read own history" ON public.bubble_history;
DROP POLICY IF EXISTS "Authenticated insert" ON public.bubble_history;

DROP POLICY IF EXISTS "Public read access" ON public.bulles;
DROP POLICY IF EXISTS "Authenticated insert" ON public.bulles;
DROP POLICY IF EXISTS "Users update own pending bubbles" ON public.bulles;
DROP POLICY IF EXISTS "Staff update all bubbles" ON public.bulles;
DROP POLICY IF EXISTS "Users delete own pending bubbles" ON public.bulles;
DROP POLICY IF EXISTS "Staff delete all bubbles" ON public.bulles;

DROP POLICY IF EXISTS "Public read access" ON public.chapitres;
DROP POLICY IF EXISTS "Staff full access" ON public.chapitres;

DROP POLICY IF EXISTS "Public read access" ON public.glossary;
DROP POLICY IF EXISTS "Staff full access" ON public.glossary;

DROP POLICY IF EXISTS "Public read access" ON public.mangas;
DROP POLICY IF EXISTS "Staff full access" ON public.mangas;

DROP POLICY IF EXISTS "Public read access" ON public.pages;
DROP POLICY IF EXISTS "Staff full access" ON public.pages;

DROP POLICY IF EXISTS "Public read access" ON public.profiles;
DROP POLICY IF EXISTS "Users update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Admin full access" ON public.profiles;

DROP POLICY IF EXISTS "Public insert feedback" ON public.search_feedback;
DROP POLICY IF EXISTS "Staff read feedback" ON public.search_feedback;

DROP POLICY IF EXISTS "Public read access" ON public.tomes;
DROP POLICY IF EXISTS "Staff full access" ON public.tomes;

-- Define Policies

-- 1. app_settings
-- Everyone can read settings
CREATE POLICY "Public read access" ON public.app_settings
  FOR SELECT USING (true);
-- Only Admins can modify settings
CREATE POLICY "Admin write access" ON public.app_settings
  FOR ALL USING (public.is_admin());

-- 2. banned_ips
-- Only staff can access banned IPs list
CREATE POLICY "Staff full access" ON public.banned_ips
  FOR ALL USING (public.is_staff());

-- 3. bubble_history
-- Staff can read all history
CREATE POLICY "Staff read access" ON public.bubble_history
  FOR SELECT USING (public.is_staff());
-- Users can read their own history
CREATE POLICY "Users read own history" ON public.bubble_history
  FOR SELECT USING (auth.uid() = user_id);
-- Authenticated users can insert history (triggers or app logic)
CREATE POLICY "Authenticated insert" ON public.bubble_history
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- 4. bulles
-- Bubbles are visible to everyone
CREATE POLICY "Public read access" ON public.bulles
  FOR SELECT USING (true);
-- Authenticated users can propose bubbles
CREATE POLICY "Authenticated insert" ON public.bulles
  FOR INSERT WITH CHECK (auth.role() = 'authenticated' AND auth.uid() = id_user_createur);
-- Users can update their own bubbles ONLY if they are still 'Proposé'
CREATE POLICY "Users update own pending bubbles" ON public.bulles
  FOR UPDATE USING (auth.uid() = id_user_createur AND statut = 'Proposé')
  WITH CHECK (auth.uid() = id_user_createur AND statut = 'Proposé');
-- Staff can update any bubble (e.g. to validate/reject)
CREATE POLICY "Staff update all bubbles" ON public.bulles
  FOR UPDATE USING (public.is_staff());
-- Users can delete their own bubbles if 'Proposé'
CREATE POLICY "Users delete own pending bubbles" ON public.bulles
  FOR DELETE USING (auth.uid() = id_user_createur AND statut = 'Proposé');
-- Staff can delete any bubble
CREATE POLICY "Staff delete all bubbles" ON public.bulles
  FOR DELETE USING (public.is_staff());

-- 5. chapitres
-- Visible to everyone
CREATE POLICY "Public read access" ON public.chapitres
  FOR SELECT USING (true);
-- Modifiable only by staff
CREATE POLICY "Staff full access" ON public.chapitres
  FOR ALL USING (public.is_staff());

-- 6. glossary
-- Visible to everyone
CREATE POLICY "Public read access" ON public.glossary
  FOR SELECT USING (true);
-- Modifiable only by staff
CREATE POLICY "Staff full access" ON public.glossary
  FOR ALL USING (public.is_staff());

-- 7. mangas
-- Visible to everyone
CREATE POLICY "Public read access" ON public.mangas
  FOR SELECT USING (true);
-- Modifiable only by staff
CREATE POLICY "Staff full access" ON public.mangas
  FOR ALL USING (public.is_staff());

-- 8. pages
-- Visible to everyone
CREATE POLICY "Public read access" ON public.pages
  FOR SELECT USING (true);
-- Modifiable only by staff
CREATE POLICY "Staff full access" ON public.pages
  FOR ALL USING (public.is_staff());

-- 9. profiles
-- Profiles are public (username, etc.)
CREATE POLICY "Public read access" ON public.profiles
  FOR SELECT USING (true);
-- Users can update their own profile
CREATE POLICY "Users update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);
-- Admins can do anything with profiles
CREATE POLICY "Admin full access" ON public.profiles
  FOR ALL USING (public.is_admin());

-- 10. search_feedback
-- Anyone can submit feedback
CREATE POLICY "Public insert feedback" ON public.search_feedback
  FOR INSERT WITH CHECK (true);
-- Only staff can read feedback
CREATE POLICY "Staff read feedback" ON public.search_feedback
  FOR SELECT USING (public.is_staff());

-- 11. tomes
-- Visible to everyone
CREATE POLICY "Public read access" ON public.tomes
  FOR SELECT USING (true);
-- Modifiable only by staff
CREATE POLICY "Staff full access" ON public.tomes
  FOR ALL USING (public.is_staff());
