-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ENUMS
CREATE TYPE user_role AS ENUM ('admin', 'teacher');
CREATE TYPE attendance_status AS ENUM ('Present', 'Late', 'Absent');

-- 1. PROFILES (Extends Supabase auth.users)
CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    employee_id VARCHAR(50) UNIQUE NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role user_role DEFAULT 'teacher' NOT NULL,
    institution_id UUID, -- Assigned later via FK
    created_at TIMESTAMPTZ DEFAULT timezone('utc', now()) NOT NULL
);

-- 2. INSTITUTIONS
CREATE TABLE institutions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    timezone VARCHAR(50) DEFAULT 'Asia/Kolkata' NOT NULL,
    created_at TIMESTAMPTZ DEFAULT timezone('utc', now()) NOT NULL
);

-- Add the foreign key to profiles now that institutions exists
ALTER TABLE profiles 
ADD CONSTRAINT fk_profiles_institution 
FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE SET NULL;

-- 3. INSTITUTION SETTINGS
CREATE TABLE institution_settings (
    institution_id UUID PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
    check_in_start TIME NOT NULL DEFAULT '07:30:00',
    check_in_deadline TIME NOT NULL DEFAULT '08:15:00',
    late_threshold TIME NOT NULL DEFAULT '08:00:00',
    working_days SMALLINT[] DEFAULT '{1,2,3,4,5,6}', -- 1=Mon, 7=Sun
    gps_lat NUMERIC(10, 7) NOT NULL,
    gps_lng NUMERIC(10, 7) NOT NULL,
    gps_radius_meters INTEGER DEFAULT 500 NOT NULL,
    is_active BOOLEAN DEFAULT true NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT timezone('utc', now()) NOT NULL
);

-- 4. ATTENDANCE RECORDS
CREATE TABLE attendance_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    teacher_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
    date DATE NOT NULL, -- Local date at the institution
    timestamp TIMESTAMPTZ DEFAULT timezone('utc', now()) NOT NULL,
    status attendance_status NOT NULL,
    gps_verified BOOLEAN NOT NULL,
    face_verified BOOLEAN NOT NULL,
    rejection_reason VARCHAR(255),
    UNIQUE(teacher_id, date) -- Prevents duplicate daily submissions
);

-- 5. ADMINISTRATIVE AUDIT LOGS
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_id UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
    action VARCHAR(100) NOT NULL,
    target_table VARCHAR(50) NOT NULL,
    target_id UUID,
    changes JSONB,
    timestamp TIMESTAMPTZ DEFAULT timezone('utc', now()) NOT NULL
);

-- INDEXES for frequent queries
CREATE INDEX idx_attendance_teacher_date ON attendance_records(teacher_id, date);
CREATE INDEX idx_attendance_institution_date ON attendance_records(institution_id, date);
CREATE INDEX idx_profiles_role ON profiles(role);