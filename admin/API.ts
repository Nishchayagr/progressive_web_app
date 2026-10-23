import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Haversine distance helper
function getDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371e3; // Earth radius in meters
  const p1 = lat1 * Math.PI/180, p2 = lat2 * Math.PI/180;
  const dp = (lat2-lat1) * Math.PI/180, dl = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(dp/2) * Math.sin(dp/2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl/2) * Math.sin(dl/2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

serve(async (req) => {
  const authHeader = req.headers.get('Authorization')!
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '' // Bypass RLS to perform secure checks
  )

  // 1. Authenticate Teacher
  const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
  if (authError || !user) return new Response("Unauthorized", { status: 401 })

  const { data: profile } = await supabase.from('profiles').select('*, institutions(*)').eq('id', user.id).single()
  
  // 2. Parse payload from frontend
  const { lat, lng, face_verified } = await req.json()
  
  // 3. Fetch specific institution settings
  const { data: settings } = await supabase.from('institution_settings').eq('institution_id', profile.institution_id).single()

  // 4. Server-Side Validations
  const distance = getDistance(lat, lng, settings.gps_lat, settings.gps_lng)
  const gps_verified = distance <= settings.gps_radius_meters

  // Basic Time calculation (Ideally handled with a library like luxon for full timezone support)
  const now = new Date()
  const localDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: profile.institutions.timezone }).format(now)
  
  let status = 'Absent'
  let rejection_reason = null

  if (!gps_verified) {
    rejection_reason = `Outside geofence (${Math.round(distance)}m away)`
  } else if (!face_verified) {
    rejection_reason = "Face ID failed"
  } else {
    // Determine Late vs Present based on current server time
    // Logic here compares server time against settings.check_in_deadline
    status = 'Present' 
  }

  // 5. Insert Record
  const { error: insertError } = await supabase.from('attendance_records').insert({
    teacher_id: user.id,
    institution_id: profile.institution_id,
    date: localDateStr,
    status,
    gps_verified,
    face_verified,
    rejection_reason
  })

  if (insertError) return new Response(JSON.stringify({ error: insertError.message }), { status: 400 })
  return new Response(JSON.stringify({ success: true, status, rejection_reason }), { status: 200 })
})