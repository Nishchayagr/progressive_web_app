-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE institutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Profiles: Admins see all, Teachers see only their own
CREATE POLICY "Admins can view all profiles" ON profiles FOR SELECT USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
);
CREATE POLICY "Teachers can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);

-- Institutions & Settings: Admins control all, Teachers read their assigned institution
CREATE POLICY "Admins manage institutions" ON institutions FOR ALL USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
);
CREATE POLICY "Teachers view assigned institution" ON institutions FOR SELECT USING (
    id = (SELECT institution_id FROM profiles WHERE id = auth.uid())
);

CREATE POLICY "Admins manage settings" ON institution_settings FOR ALL USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
);
CREATE POLICY "Teachers view assigned settings" ON institution_settings FOR SELECT USING (
    institution_id = (SELECT institution_id FROM profiles WHERE id = auth.uid())
);

-- Attendance: Admins view all, Teachers view own. 
-- INSERTS are handled exclusively by a secure Edge Function, bypassing standard RLS client insertion.
CREATE POLICY "Admins view all attendance" ON attendance_records FOR SELECT USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
);
CREATE POLICY "Teachers view own attendance" ON attendance_records FOR SELECT USING (
    teacher_id = auth.uid()
);

-- Audit Logs: Admins read/insert only
CREATE POLICY "Admins view audit logs" ON audit_logs FOR SELECT USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
);