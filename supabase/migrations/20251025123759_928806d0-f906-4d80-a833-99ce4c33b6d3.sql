-- Fase 1: Data Cleanup

-- 1. Verwijder duplicate Remco Derks (id 77 heeft 0 clients)
DELETE FROM advisors 
WHERE id = 77 
AND name = 'Remco Derks' 
AND "VoAdvisor" = 'Derks, R.G.J.';

-- 2. Voeg unique constraint toe op VoAdvisor om toekomstige duplicates te voorkomen
ALTER TABLE advisors 
ADD CONSTRAINT advisors_voadvisor_unique 
UNIQUE ("VoAdvisor");

-- 3. Voeg index toe voor snellere case-insensitive naam lookups
CREATE INDEX IF NOT EXISTS idx_advisors_name_lower 
ON advisors (LOWER(name));

-- 4. Maak functie voor duplicate detection
CREATE OR REPLACE FUNCTION check_duplicate_advisors()
RETURNS TABLE(name TEXT, count BIGINT, ids TEXT) 
LANGUAGE sql 
STABLE 
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    a.name, 
    COUNT(*) as count,
    STRING_AGG(a.id::TEXT, ', ' ORDER BY a.id) as ids
  FROM advisors a
  GROUP BY a.name
  HAVING COUNT(*) > 1
$$;

-- 5. Grant execute permission op functie voor authenticated users
GRANT EXECUTE ON FUNCTION check_duplicate_advisors() TO authenticated;