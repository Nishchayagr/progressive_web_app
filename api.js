

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const SUPABASE_URL = 'https://feiqyrcmxhdniwwuqjum.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZlaXF5cmNteGhkbml3d3VxanVtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3MjAxOTcsImV4cCI6MjEwODI5NjE5N30.1XAerZtBY7H8-Sc-VvD3qqfvhqOQYmRKKR1yjysnvPw';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);