// Lafiya Line API. The Supabase service key stays on this server only.
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://lafiya-line-voice.onrender.com').replace(/\/$/, '');
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://elijahamosdogo-afk.github.io';
const AUDIO_BASE_URL = 'https://elijahamosdogo-afk.github.io/Lafiya-line-/audio';
const CONSENT_VERSION = process.env.CONSENT_VERSION || 'consent-v1';
const CALLS_ENABLED = process.env.CALLS_ENABLED === 'true';
const AUDIO_APPROVED = process.env.AUDIO_APPROVED === 'true';
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('Missing Supabase environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const twilioConfigured = Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
const twilioClient = twilioConfigured ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin === FRONTEND_ORIGIN) res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const fail = (res, status, message) => res.status(status).json({ error: message });
const requireAuth = async (req, res, next) => {
  try {
    const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    if (!match) return fail(res, 401, 'Please sign in again.');
    const { data: authData, error: authError } = await supabase.auth.getUser(match[1]);
    if (authError || !authData.user) return fail(res, 401, 'Your sign-in has expired. Please sign in again.');
    const { data: profile, error } = await supabase.from('profiles').select('id,facility_id,role,full_name,is_active').eq('id', authData.user.id).maybeSingle();
    if (error || !profile || !profile.is_active) return fail(res, 403, 'This account is not active in Lafiya Line.');
    req.user = authData.user;
    req.profile = profile;
    next();
  } catch (error) {
    console.error('Authentication error:', error.message);
    fail(res, 401, 'Could not verify your sign-in.');
  }
};
const staff = (...roles) => (req, res, next) => roles.includes(req.profile.role) ? next() : fail(res, 403, 'You do not have permission to do that.');
const hasFacility = (profile, facilityId) => profile.role === 'system_admin' || profile.facility_id === facilityId;
const normalizePhone = value => {
  if (typeof value !== 'string') return null;
  const n = value.replace(/[\s()-]/g, '');
  const normalized = /^0[789]\d{9}$/.test(n) ? '+234' + n.slice(1) : n;
  return /^\+234[789]\d{9}$/.test(normalized) ? normalized : null;
};
const stageMap = {
  'Birth': ['Birth - BCG', '6 weeks - Rotavirus'], '6 weeks': ['6 weeks - Rotavirus', '10 weeks - Rotavirus'],
  '10 weeks': ['10 weeks - Rotavirus', '14 weeks - Rotavirus'], '14 weeks': ['14 weeks - Rotavirus', '9 months - Nine-month'],
  '9 months': ['9 months - Nine-month', '15 months - Nine-month'], '15 months': ['15 months - Nine-month', null]
};
const languageMap = { English: 'en', Hausa: 'ha', Kanuri: 'kr', en: 'en', ha: 'ha', kr: 'kr' };
const stageName = Object.fromEntries(Object.entries(stageMap).map(([label, values]) => [values[0], label]));

function scheduledAt(vaccinatedAt, hours) {
  // Africa/Lagos is UTC+1 with no daylight saving time.
  const target = new Date(new Date(vaccinatedAt).getTime() + hours * 3600000);
  const local = new Date(target.getTime() + 3600000);
  const hour = local.getUTCHours(), minute = local.getUTCMinutes(), second = local.getUTCSeconds();
  const localMinutes = hour * 60 + minute + second / 60 + local.getUTCMilliseconds() / 60000;
  if (localMinutes >= 420 && localMinutes <= 1200) return target.toISOString();
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + (localMinutes > 1200 ? 1 : 0), 7));
  return new Date(day.getTime() - 3600000).toISOString();
}
async function saveVaccination(args) {
  const { data: atomic, error: rpcError } = await supabase.rpc('create_aftercare_vaccination', args);
  if (!rpcError) return atomic;
  // The already-deployed draft has migrations 0001/0002. Keep normal stages
  // usable during rollout; 0004 switches writes to an atomic database function.
  if (rpcError.code !== 'PGRST202') throw rpcError;
  if (args.p_schedule_complete) {
    const error = new Error('Apply migrations 0003_final_dose_completion.sql and 0004_atomic_aftercare_vaccination.sql before recording the 15-month final dose.');
    error.code = 'FINAL_DOSE_MIGRATION_REQUIRED';
    throw error;
  }
  const { data: appointment, error: appointmentError } = await supabase.from('appointment').insert({
    child_id: args.p_child_id, vaccine_type: args.p_vaccine_type, vaccinated_at: args.p_vaccinated_at,
    next_dose_stage: args.p_next_dose_stage, next_dose_due_at: args.p_next_dose_due_at,
    schedule_complete: false, schedule_completed_at: null, recorded_by: args.p_recorded_by
  }).select('id').single();
  if (appointmentError) throw appointmentError;
  let calls = [];
  if (args.p_create_calls) {
    const rows = [24,72].map(hours => ({ appointment_id: appointment.id, follow_up_hours: hours, scheduled_at: scheduledAt(args.p_vaccinated_at, hours), language_code: args.p_language_code }));
    const { data, error: callsError } = await supabase.from('calls').insert(rows).select('id');
    if (callsError) {
      await supabase.from('appointment').delete().eq('id', appointment.id);
      throw callsError;
    }
    calls = data || [];
  }
  return { appointment_id: appointment.id, call_ids: calls.map(x => x.id) };
}

app.get('/', (_req, res) => res.send('Lafiya Line API is running.'));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/db-check', async (_req, res) => {
  const { error } = await supabase.from('facilities').select('id').limit(1);
  if (error) return fail(res, 503, 'Database connection failed.');
  res.json({ connected: true });
});

// Login uses Supabase Auth; no shared/demo passwords are accepted by the live app.
app.post('/api/auth/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return fail(res, 400, 'Enter your work email and password.');
    const authClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    const { data, error } = await authClient.auth.signInWithPassword({ email, password });
    if (error || !data.session || !data.user) return fail(res, 401, 'Email or password is incorrect.');
    const { data: profile, error: profileError } = await supabase.from('profiles').select('id,facility_id,role,full_name,is_active').eq('id', data.user.id).maybeSingle();
    if (profileError || !profile || !profile.is_active) return fail(res, 403, 'Your account has no active Lafiya Line staff profile. Ask your administrator to set it up.');
    if (profile.facility_id) {
      const { data: facility } = await supabase.from('facilities').select('id,is_active').eq('id', profile.facility_id).maybeSingle();
      if (!facility?.is_active) return fail(res, 403, 'Your facility is inactive. Contact the system administrator.');
    }
    res.json({ access_token: data.session.access_token, expires_in: data.session.expires_in, user: profile });
  } catch (error) {
    console.error('Login error:', error.message);
    fail(res, 503, 'Sign-in is temporarily unavailable.');
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.profile }));

// Build one facility-scoped view for the existing dashboard. All queries use the
// server key, so every facility filter is enforced here before data is returned.
app.get('/api/bootstrap', requireAuth, async (req, res) => {
  try {
    const p = req.profile;
    let facilitiesQuery = supabase.from('facilities').select('*').order('name');
    if (p.role !== 'system_admin') facilitiesQuery = facilitiesQuery.eq('id', p.facility_id);
    const { data: facilities, error: facilityError } = await facilitiesQuery;
    if (facilityError) throw facilityError;
    const facilityIds = (facilities || []).map(x => x.id);
    if (!facilityIds.length) return res.json({ user: p, facilities: [], caregivers: [], children: [], appointments: [], calls: [], attempts: [], callbacks: [], profiles: [], callingReady: CALLS_ENABLED && AUDIO_APPROVED && twilioConfigured });

    let profilesQuery = supabase.from('profiles').select('id,facility_id,role,full_name,phone,is_active,created_at');
    if (p.role !== 'system_admin') profilesQuery = profilesQuery.in('facility_id', facilityIds);
    const [cgResult, profilesResult, callbackResult] = await Promise.all([
      supabase.from('caregivers').select('*').in('facility_id', facilityIds).order('created_at', { ascending: false }),
      profilesQuery,
      supabase.from('callbacks').select('*').in('facility_id', facilityIds).order('created_at', { ascending: false })
    ]);
    if (cgResult.error) throw cgResult.error;
    if (profilesResult.error) throw profilesResult.error;
    if (callbackResult.error) throw callbackResult.error;
    const caregivers = cgResult.data || [];
    const childrenResult = caregivers.length
      ? await supabase.from('children').select('*').in('caregiver_id', caregivers.map(x => x.id))
      : { data: [], error: null };
    if (childrenResult.error) throw childrenResult.error;
    const children = childrenResult.data || [];
    const appointmentsResult = children.length
      ? await supabase.from('appointment').select('*').in('child_id', children.map(x => x.id)).order('vaccinated_at', { ascending: false })
      : { data: [], error: null };
    if (appointmentsResult.error) throw appointmentsResult.error;
    const appointments = appointmentsResult.data || [];
    const callsResult = appointments.length
      ? await supabase.from('calls').select('*').in('appointment_id', appointments.map(x => x.id)).order('scheduled_at', { ascending: false })
      : { data: [], error: null };
    if (callsResult.error) throw callsResult.error;
    const calls = callsResult.data || [];
    const attemptsResult = calls.length
      ? await supabase.from('call_attempts').select('*').in('call_id', calls.map(x => x.id)).order('attempt_number')
      : { data: [], error: null };
    if (attemptsResult.error) throw attemptsResult.error;
    const profiles = await Promise.all((profilesResult.data || []).map(async profile => {
      const { data: authUser } = await supabase.auth.admin.getUserById(profile.id);
      return { ...profile, email: authUser?.user?.email || null };
    }));
    return res.json({ user: p, facilities, caregivers, children, appointments, calls, attempts: attemptsResult.data || [], callbacks: callbackResult.data || [], profiles, callingReady: CALLS_ENABLED && AUDIO_APPROVED && twilioConfigured });
  } catch (error) {
    console.error('Bootstrap error:', error.message);
    fail(res, 503, 'Could not load your facility records.');
  }
});

app.post('/api/register', requireAuth, staff('system_admin', 'facility_admin', 'health_worker'), async (req, res) => {
  let caregiverId, childId, appointmentId, caregiverCreated = false, callIds = [];
  try {
    const p = req.profile;
    const { fullName, phone, language, referredBy, age, ageUnit, dose, nextDoseDate, facilityId, consentGiven } = req.body || {};
    const facility = p.role === 'system_admin' ? facilityId : p.facility_id;
    if (!facility || !hasFacility(p, facility)) return fail(res, 403, 'Choose a facility assigned to your account.');
    const normalizedPhone = normalizePhone(phone);
    const numericAge = Number(age);
    const stage = stageMap[dose];
    const languageCode = languageMap[language];
    if (!normalizedPhone) return fail(res, 400, 'Enter a valid Nigerian phone number.');
    if (!languageCode) return fail(res, 400, 'Choose English, Hausa or Kanuri.');
    if (!Number.isInteger(numericAge) || numericAge <= 0 || !['weeks', 'months'].includes(ageUnit) || numericAge > (ageUnit === 'weeks' ? 104 : 59)) return fail(res, 400, 'Enter a positive age in weeks or months.');
    if (!stage) return fail(res, 400, 'Choose the dose given today.');
    const isFinalDose = dose === '15 months';
    if (!isFinalDose && (!/^\d{4}-\d{2}-\d{2}$/.test(nextDoseDate || '') || Number.isNaN(Date.parse(nextDoseDate + 'T12:00:00+01:00')) || nextDoseDate <= new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()))) return fail(res, 400, 'Choose a future date for the next dose.');

    const now = new Date();
    const { data: existingCaregiver, error: existingError } = await supabase.from('caregivers').select('id,consent_given,consent_withdrawn_at').eq('facility_id', facility).eq('phone', normalizedPhone).maybeSingle();
    if (existingError) throw existingError;
    let caregiver = existingCaregiver;
    if (!caregiver) {
      if (!String(fullName || '').trim()) return fail(res, 400, 'Enter the caregiver’s full name.');
      if (consentGiven !== true) return fail(res, 400, 'Record the caregiver’s verbal consent before scheduling calls.');
      const { data, error: caregiverError } = await supabase.from('caregivers').insert({
        facility_id: facility, full_name: String(fullName).trim(), phone: normalizedPhone, preferred_language: languageCode,
        consent_given: true, consent_given_at: now.toISOString(), consent_version: CONSENT_VERSION,
        referred_by: String(referredBy || '').trim() || null
      }).select('id,consent_given,consent_withdrawn_at').single();
      if (caregiverError) throw caregiverError;
      caregiver = data;
      caregiverCreated = true;
    } else if (caregiver.consent_given && !caregiver.consent_withdrawn_at) {
      const { error: updateCaregiverError } = await supabase.from('caregivers').update({ preferred_language: languageCode, referred_by: String(referredBy || '').trim() || null }).eq('id', caregiver.id);
      if (updateCaregiverError) throw updateCaregiverError;
    }
    caregiverId = caregiver.id;

    const { data: child, error: childError } = await supabase.from('children').insert({
      caregiver_id: caregiverId, age_value: numericAge, age_unit: ageUnit,
      enrolled_at: now.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })
    }).select('id').single();
    if (childError) throw childError;
    childId = child.id;

    const dueAt = isFinalDose ? null : new Date(nextDoseDate + 'T12:00:00+01:00').toISOString();
    const saved = await saveVaccination({
      p_child_id: childId, p_vaccine_type: stage[0], p_vaccinated_at: now.toISOString(),
      p_next_dose_stage: isFinalDose ? null : stage[1], p_next_dose_due_at: dueAt,
      p_schedule_complete: isFinalDose, p_schedule_completed_at: isFinalDose ? now.toISOString() : null,
      p_recorded_by: p.id, p_language_code: languageCode,
      p_create_calls: caregiver.consent_given && !caregiver.consent_withdrawn_at
    });
    appointmentId = saved.appointment_id;
    callIds = saved.call_ids || [];
    if (isFinalDose) await maybeDeleteCaregiverPhone(caregiverId);
    res.status(201).json({ success: true, caregiver_id: caregiverId, child_id: childId, appointment_id: appointmentId, call_ids: callIds });
  } catch (error) {
    console.error('Registration error:', { message: error.message, code: error.code });
    // Reverse only this incomplete new enrollment. Operational records are never deleted.
    if (callIds.length) await supabase.from('calls').delete().in('id', callIds);
    if (appointmentId) await supabase.from('appointment').delete().eq('id', appointmentId);
    if (childId) await supabase.from('children').delete().eq('id', childId);
    if (caregiverId && caregiverCreated) await supabase.from('caregivers').delete().eq('id', caregiverId);
    fail(res, 400, error.message || 'Could not save this enrolment.');
  }
});

app.patch('/api/caregivers/:id', requireAuth, staff('system_admin', 'facility_admin', 'health_worker'), async (req, res) => {
  try {
    const { data: caregiver, error } = await supabase.from('caregivers').select('*').eq('id', req.params.id).single();
    if (error || !caregiver || !hasFacility(req.profile, caregiver.facility_id)) return fail(res, 404, 'Caregiver record not found.');
    const updates = {};
    if (req.body?.phone !== undefined) {
      const phone = normalizePhone(req.body.phone);
      if (!phone) return fail(res, 400, 'Enter a valid Nigerian phone number.');
      updates.phone = phone;
    }
    if (req.body?.language !== undefined) {
      const code = languageMap[req.body.language];
      if (!code) return fail(res, 400, 'Choose English, Hausa or Kanuri.');
      updates.preferred_language = code;
    }
    if (req.body?.referredBy !== undefined) updates.referred_by = String(req.body.referredBy || '').trim() || null;
    if (req.body?.withdrawConsent === true && caregiver.consent_given && !caregiver.consent_withdrawn_at) {
      const now = new Date().toISOString();
      updates.consent_given = false;
      updates.consent_withdrawn_at = now;
    }
    if (req.body?.deletePhone === true) {
      const { data: children } = await supabase.from('children').select('id').eq('caregiver_id', caregiver.id);
      const { data: appts } = children?.length ? await supabase.from('appointment').select('id,schedule_complete').in('child_id', children.map(x => x.id)) : { data: [] };
      const incomplete = (appts || []).some(x => !x.schedule_complete);
      if (incomplete) return fail(res, 409, 'The caregiver’s number is retained while a child still has scheduled doses.');
      const { count: otherActiveChildren } = await supabase.from('children').select('id', { count: 'exact', head: true }).neq('caregiver_id', caregiver.id).in('caregiver_id', (await supabase.from('caregivers').select('id').eq('facility_id', caregiver.facility_id).eq('phone', caregiver.phone)).data?.map(x => x.id) || []);
      if (otherActiveChildren > 0) return fail(res, 409, 'This number is still linked to another enrolled child.');
      updates.phone = null;
    }
    if (!Object.keys(updates).length) return fail(res, 400, 'No supported changes were provided.');
    const { data: saved, error: updateError } = await supabase.from('caregivers').update(updates).eq('id', caregiver.id).select('id,phone,preferred_language,consent_given,consent_withdrawn_at,referred_by').single();
    if (updateError) throw updateError;
    if (updates.consent_withdrawn_at) {
      const { data: children } = await supabase.from('children').select('id').eq('caregiver_id', caregiver.id);
      const { data: appointments } = children?.length ? await supabase.from('appointment').select('id').in('child_id', children.map(x => x.id)) : { data: [] };
      const { data: pending } = appointments?.length ? await supabase.from('calls').select('id').in('appointment_id', appointments.map(x => x.id)).eq('status', 'scheduled') : { data: [] };
      if (pending?.length) await supabase.from('calls').update({ status: 'cancelled', completed_at: new Date().toISOString() }).in('id', pending.map(x => x.id));
    }
    res.json({ success: true, caregiver: saved });
  } catch (error) {
    console.error('Caregiver update error:', error.message);
    fail(res, 400, 'Could not update this caregiver.');
  }
});

app.post('/api/vaccinations', requireAuth, staff('system_admin', 'facility_admin', 'health_worker'), async (req, res) => {
  let appointmentId, callIds = [];
  try {
    const { childId, dose, nextDoseDate } = req.body || {};
    const stage = stageMap[dose];
    if (!stage) return fail(res, 400, 'Choose the dose given today.');
    const isFinalDose = dose === '15 months';
    if (!isFinalDose && (!/^\d{4}-\d{2}-\d{2}$/.test(nextDoseDate || '') || Number.isNaN(Date.parse(nextDoseDate + 'T12:00:00+01:00')) || nextDoseDate <= new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()))) return fail(res, 400, 'Choose a future date for the next dose.');
    const { data: child, error: childError } = await supabase.from('children').select('id,caregiver_id').eq('id', childId).single();
    const { data: caregiver } = child ? await supabase.from('caregivers').select('id,facility_id,consent_given,consent_withdrawn_at,preferred_language,phone').eq('id', child.caregiver_id).single() : { data: null };
    if (childError || !child || !caregiver || !hasFacility(req.profile, caregiver.facility_id)) return fail(res, 404, 'Child not found at your facility.');
    if (!caregiver.phone && caregiver.consent_given && !caregiver.consent_withdrawn_at) return fail(res, 409, 'This caregiver’s number has been deleted; update the record before continuing.');
    const { data: duplicate } = await supabase.from('appointment').select('id').eq('child_id', child.id).eq('vaccine_type', stage[0]).maybeSingle();
    if (duplicate) return fail(res, 409, 'This dose stage is already recorded for this child.');
    const now = new Date();
    const dueAt = isFinalDose ? null : new Date(nextDoseDate + 'T12:00:00+01:00').toISOString();
    const saved = await saveVaccination({
      p_child_id: child.id, p_vaccine_type: stage[0], p_vaccinated_at: now.toISOString(),
      p_next_dose_stage: isFinalDose ? null : stage[1], p_next_dose_due_at: dueAt,
      p_schedule_complete: isFinalDose, p_schedule_completed_at: isFinalDose ? now.toISOString() : null,
      p_recorded_by: req.profile.id, p_language_code: caregiver.preferred_language,
      p_create_calls: Boolean(caregiver.phone && caregiver.consent_given && !caregiver.consent_withdrawn_at)
    });
    appointmentId = saved.appointment_id;
    callIds = saved.call_ids || [];
    if (isFinalDose) await maybeDeleteCaregiverPhone(caregiver.id);
    res.status(201).json({ success: true, appointment_id: appointment.id, call_ids: callIds });
  } catch (error) {
    console.error('Vaccination save error:', { message: error.message, code: error.code });
    if (callIds.length) await supabase.from('calls').delete().in('id', callIds);
    if (appointmentId) await supabase.from('appointment').delete().eq('id', appointmentId);
    fail(res, 400, error.message || 'Could not save this vaccination.');
  }
});

app.patch('/api/appointments/:id', requireAuth, staff('system_admin', 'facility_admin', 'health_worker'), async (req, res) => {
  try {
    const { data: appointment, error } = await supabase.from('appointment').select('id,child_id').eq('id', req.params.id).single();
    if (error || !appointment) return fail(res, 404, 'Vaccination record not found.');
    const { data: child } = await supabase.from('children').select('caregiver_id').eq('id', appointment.child_id).single();
    const { data: caregiver } = child ? await supabase.from('caregivers').select('facility_id').eq('id', child.caregiver_id).single() : { data: null };
    if (!caregiver || !hasFacility(req.profile, caregiver.facility_id)) return fail(res, 404, 'Vaccination record not found.');
    return res.json({ success: true, note: 'Vaccination history is retained. This version does not permit overwriting the administered-vaccine record.' });
  } catch (_error) { return fail(res, 400, 'Could not update the vaccination record.'); }
});

const dangerColumns = ['danger_stopped_feeding','danger_fits_or_shaking','danger_vomiting_everything','danger_unusually_sleepy_or_hard_to_wake','danger_fast_or_difficult_breathing','danger_yellow_eyes_or_skin','danger_injection_site_large_hot_or_pus'];
async function maybeDeleteCaregiverPhone(caregiverId) {
  const { data: children } = await supabase.from('children').select('id,is_active').eq('caregiver_id', caregiverId);
  if (!children?.length) return;
  if (children.some(child => child.is_active)) return; // Another child is still enrolled.
  const { data: appointments } = await supabase.from('appointment').select('id,schedule_complete').in('child_id', children.map(x => x.id));
  if (!appointments?.length || appointments.some(x => !x.schedule_complete)) return;
  const { data: calls } = await supabase.from('calls').select('status').in('appointment_id', appointments.map(x => x.id));
  if ((calls || []).some(x => ['scheduled','in_progress'].includes(x.status))) return;
  const { data: openTasks } = await supabase.from('callbacks').select('id').in('child_id', children.map(x => x.id)).neq('status', 'completed').neq('status', 'cancelled').limit(1);
  if (openTasks?.length) return;
  await supabase.from('caregivers').update({ phone: null }).eq('id', caregiverId).not('phone', 'is', null);
}
app.patch('/api/callbacks/:id', requireAuth, staff('system_admin', 'facility_admin', 'health_worker'), async (req, res) => {
  try {
    const { data: existing, error } = await supabase.from('callbacks').select('*').eq('id', req.params.id).single();
    if (error || !existing || !hasFacility(req.profile, existing.facility_id)) return fail(res, 404, 'Callback task not found.');
    const updates = {};
    if (Array.isArray(req.body?.dangerSigns)) {
      const selected = new Set(req.body.dangerSigns);
      const keys = ['stopped_feeding','fits_or_shaking','vomiting_everything','unusually_sleepy_or_hard_to_wake','fast_or_difficult_breathing','yellow_eyes_or_skin','injection_site_large_hot_or_pus'];
      dangerColumns.forEach((column, index) => updates[column] = selected.has(keys[index]));
    }
    if (req.body?.resolution !== undefined) {
      const valid = { Reassured: 'reassured', 'Come in today': 'come_in_today', Escalated: 'escalated' };
      if (!valid[req.body.resolution]) return fail(res, 400, 'Choose a callback outcome.');
      updates.resolution = valid[req.body.resolution];
    }
    if (req.body?.complete === true) {
      if (!existing.resolution && !updates.resolution) return fail(res, 400, 'Choose an outcome before completing the callback.');
      updates.status = 'completed'; updates.completed_at = new Date().toISOString(); updates.called_back_at = updates.completed_at;
    }
    if (req.body?.assignTo !== undefined) {
      if (req.body.assignTo === null) updates.assigned_to = null;
      else {
        const { data: assignee } = await supabase.from('profiles').select('id,facility_id,role,is_active').eq('id', req.body.assignTo).single();
        if (!assignee || !assignee.is_active || assignee.facility_id !== existing.facility_id || !['health_worker','facility_admin'].includes(assignee.role)) return fail(res, 400, 'The selected worker must be active at this facility.');
        updates.assigned_to = assignee.id; updates.status = 'assigned';
      }
    }
    if (!Object.keys(updates).length) return fail(res, 400, 'No supported changes were provided.');
    const { data, error: updateError } = await supabase.from('callbacks').update(updates).eq('id', existing.id).select('*').single();
    if (updateError) throw updateError;
    if (updates.status === 'completed') {
      const { data: child } = await supabase.from('children').select('caregiver_id').eq('id', existing.child_id).single();
      if (child) await maybeDeleteCaregiverPhone(child.caregiver_id);
    }
    res.json({ success: true, callback: data });
  } catch (error) {
    console.error('Callback update error:', error.message);
    fail(res, 400, 'Could not save the callback update.');
  }
});

app.post('/api/callbacks', requireAuth, staff('system_admin', 'facility_admin', 'health_worker'), async (req, res) => {
  try {
    const childId = req.body?.childId;
    const { data: child, error } = await supabase.from('children').select('id,caregiver_id').eq('id', childId).single();
    const { data: caregiver } = child ? await supabase.from('caregivers').select('facility_id').eq('id', child.caregiver_id).single() : { data: null };
    if (error || !child || !caregiver || !hasFacility(req.profile, caregiver.facility_id)) return fail(res, 404, 'Child not found at your facility.');
    const { data, error: insertError } = await supabase.from('callbacks').insert({
      facility_id: caregiver.facility_id, child_id: child.id, call_id: null, source: 'manual', priority: 'normal',
      status: 'open', description: String(req.body?.description || '').trim() || null, created_by: req.profile.id
    }).select('*').single();
    if (insertError) throw insertError;
    res.status(201).json({ success: true, callback: data });
  } catch (error) {
    console.error('Manual callback creation error:', error.message);
    fail(res, 400, 'Could not create the callback task.');
  }
});

app.post('/api/users', requireAuth, async (req, res) => {
  const actor = req.profile;
  const { email, password, fullName, phone, role, facilityId } = req.body || {};
  const allowedRole = actor.role === 'system_admin' ? role === 'facility_admin' : actor.role === 'facility_admin' && role === 'health_worker';
  const facility = actor.role === 'system_admin' ? facilityId : actor.facility_id;
  if (!allowedRole || !facility || !hasFacility(actor, facility)) return fail(res, 403, 'System admins create facility admins; facility admins create health workers in their own facility.');
  if (typeof email !== 'string' || !email.includes('@') || typeof password !== 'string' || password.length < 12 || !String(fullName || '').trim()) return fail(res, 400, 'Provide a valid email, a password of at least 12 characters, and the staff member’s name.');
  let newUserId;
  try {
    const { data: created, error: createError } = await supabase.auth.admin.createUser({ email: email.trim().toLowerCase(), password, email_confirm: true });
    if (createError) throw createError;
    newUserId = created.user.id;
    const { data: profile, error: profileError } = await supabase.from('profiles').insert({ id: newUserId, facility_id: facility, role, full_name: String(fullName).trim(), phone: String(phone || '').trim() || null }).select('id,facility_id,role,full_name,phone,is_active').single();
    if (profileError) throw profileError;
    res.status(201).json({ success: true, profile });
  } catch (error) {
    if (newUserId) await supabase.auth.admin.deleteUser(newUserId);
    console.error('Staff provisioning error:', error.message);
    fail(res, 400, 'Could not create this staff account. Check whether the email is already used.');
  }
});

app.post('/api/facilities', requireAuth, staff('system_admin'), async (req, res) => {
  const { name, code, phone, address } = req.body || {};
  const normalizedPhone = normalizePhone(phone);
  if (!String(name || '').trim() || !String(code || '').trim() || !normalizedPhone) return fail(res, 400, 'Facility name, unique code, and a valid Nigerian duty phone are required.');
  const { data, error } = await supabase.from('facilities').insert({ name: String(name).trim(), code: String(code).trim(), phone: normalizedPhone, address: String(address || '').trim() || null }).select('*').single();
  if (error) return fail(res, 400, 'Could not create facility. Check that its code is unique.');
  res.status(201).json({ success: true, facility: data });
});

// Calling remains disabled until the Twilio subscription/credit is ready and an
// administrator deliberately sets CALLS_ENABLED=true in the Render environment.
app.post('/api/calls/:id/initiate', requireAuth, staff('system_admin', 'facility_admin', 'health_worker'), async (req, res) => {
  if (!CALLS_ENABLED || !AUDIO_APPROVED || !twilioClient) return fail(res, 503, 'Outbound calls are paused until Twilio credit and approved complete recordings are ready.');
  let attempt;
  try {
    const { data: scheduledCall, error } = await supabase.from('calls').select('*').eq('id', req.params.id).single();
    if (error || !scheduledCall) return fail(res, 404, 'Scheduled call not found.');
    const { data: appointment } = await supabase.from('appointment').select('id,child_id').eq('id', scheduledCall.appointment_id).single();
    const { data: child } = appointment ? await supabase.from('children').select('id,caregiver_id').eq('id', appointment.child_id).single() : { data: null };
    const { data: caregiver } = child ? await supabase.from('caregivers').select('facility_id,phone,preferred_language,consent_given,consent_withdrawn_at').eq('id', child.caregiver_id).single() : { data: null };
    if (!caregiver || !hasFacility(req.profile, caregiver.facility_id)) return fail(res, 404, 'Scheduled call not found.');
    if (!caregiver.phone || !caregiver.consent_given || caregiver.consent_withdrawn_at) return fail(res, 409, 'No call can be made without a current phone number and consent.');
    if (scheduledCall.status !== 'scheduled' || new Date(scheduledCall.scheduled_at) > new Date()) return fail(res, 409, 'This call is not due yet.');
    const { count, error: countError } = await supabase.from('call_attempts').select('id', { count: 'exact', head: true }).eq('call_id', scheduledCall.id);
    if (countError) throw countError;
    if (count >= 1) return fail(res, 409, 'Automatic retries are not enabled for this version.');
    const { data: madeAttempt, error: attemptError } = await supabase.from('call_attempts').insert({ call_id: scheduledCall.id, attempt_number: count + 1, status: 'initiated' }).select('id').single();
    if (attemptError) throw attemptError;
    attempt = madeAttempt;
    const language = scheduledCall.language_code === 'kr' ? 'ha' : scheduledCall.language_code;
    const voiceUrl = `${PUBLIC_BASE_URL}/twilio/voice?callId=${encodeURIComponent(scheduledCall.id)}&attemptId=${encodeURIComponent(attempt.id)}&language=${language}&hours=${scheduledCall.follow_up_hours}`;
    const statusUrl = `${PUBLIC_BASE_URL}/twilio/status?callId=${encodeURIComponent(scheduledCall.id)}&attemptId=${encodeURIComponent(attempt.id)}`;
    const dialed = await twilioClient.calls.create({ to: caregiver.phone, from: process.env.TWILIO_PHONE_NUMBER, url: voiceUrl, method: 'POST', statusCallback: statusUrl, statusCallbackMethod: 'POST', statusCallbackEvent: ['initiated','ringing','answered','completed'] });
    await supabase.from('call_attempts').update({ twilio_call_sid: dialed.sid, provider_status: dialed.status }).eq('id', attempt.id);
    await supabase.from('calls').update({ status: 'in_progress' }).eq('id', scheduledCall.id);
    res.json({ success: true, callSid: dialed.sid, attemptId: attempt.id });
  } catch (error) {
    if (attempt) await supabase.from('call_attempts').delete().eq('id', attempt.id);
    console.error('Twilio initiation error:', error.message);
    fail(res, 502, 'Twilio could not start the call.');
  }
});

function verifyTwilio(req, res, next) {
  if (!twilioConfigured) return fail(res, 503, 'Twilio is not configured.');
  const signature = req.get('x-twilio-signature') || '';
  const url = PUBLIC_BASE_URL + req.originalUrl;
  if (!twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body || {})) return fail(res, 403, 'Invalid Twilio signature.');
  next();
}

app.post('/twilio/voice', verifyTwilio, (req, res) => {
  const language = req.query.language;
  const callId = String(req.query.callId || '');
  const attemptId = String(req.query.attemptId || '');
  if (!['en','ha'].includes(language) || !callId || !attemptId) return fail(res, 400, 'Invalid call details.');
  const hours = Number(req.query.hours) === 72 ? 72 : 24;
  const recording = `call${hours === 72 ? 2 : 1}_${language}.mp3`;
  const vr = new twilio.twiml.VoiceResponse();
  vr.play(`${PUBLIC_BASE_URL}/audio/${recording}`);
  vr.gather({ numDigits: 1, timeout: 8, actionOnEmptyResult: true, method: 'POST', action: `${PUBLIC_BASE_URL}/twilio/key?callId=${encodeURIComponent(callId)}&attemptId=${encodeURIComponent(attemptId)}&language=${language}&hours=${hours}` });
  res.type('text/xml').send(vr.toString());
});

app.post('/twilio/key', verifyTwilio, async (req, res) => {
  const { callId, attemptId, language, hours } = req.query;
  const digit = String(req.body?.Digits || '');
  try {
    const { data: call, error } = await supabase.from('calls').select('id,appointment_id,status').eq('id', callId).single();
    const { data: attempt } = await supabase.from('call_attempts').select('id,keypad_sequence,status,response').eq('id', attemptId).eq('call_id', callId).single();
    if (error || !call || !attempt) return fail(res, 404, 'Call not found.');
    if (attempt.status === 'completed') {
      const done = new twilio.twiml.VoiceResponse(); done.say('Thank you. Goodbye.'); done.hangup();
      return res.type('text/xml').send(done.toString());
    }
    const validDigit = /^[1-4]$/.test(digit);
    const sequence = validDigit ? [...(attempt.keypad_sequence || []), Number(digit)] : (attempt.keypad_sequence || []);
    await supabase.from('call_attempts').update({ keypad_sequence: sequence }).eq('id', attempt.id);
    const vr = new twilio.twiml.VoiceResponse();
    if (digit === '3') {
      const rec = `call${Number(hours) === 72 ? 2 : 1}_${language}.mp3`;
      vr.play(`${PUBLIC_BASE_URL}/audio/${rec}`);
      vr.gather({ numDigits: 1, timeout: 8, actionOnEmptyResult: true, method: 'POST', action: `${PUBLIC_BASE_URL}/twilio/key?callId=${encodeURIComponent(callId)}&attemptId=${encodeURIComponent(attemptId)}&language=${language}&hours=${hours}` });
      return res.type('text/xml').send(vr.toString());
    }
    if (digit === '4') {
      vr.say({ language: language === 'ha' ? 'ha-NG' : 'en-NG' }, 'For Hausa press 1. For English press 2.');
      vr.gather({ numDigits: 1, timeout: 8, actionOnEmptyResult: true, method: 'POST', action: `${PUBLIC_BASE_URL}/twilio/language?callId=${encodeURIComponent(callId)}&attemptId=${encodeURIComponent(attemptId)}&hours=${hours}` });
      return res.type('text/xml').send(vr.toString());
    }
    const response = digit === '1' ? 'worried' : digit === '2' ? 'well' : null;
    const outcome = digit ? 'answered' : 'answered';
    await supabase.from('call_attempts').update({ response, outcome, status: 'completed', ended_at: new Date().toISOString() }).eq('id', attempt.id);
    await supabase.from('calls').update({ status: response === 'worried' ? 'answered_worried' : response === 'well' ? 'answered_well' : 'failed', completed_at: new Date().toISOString() }).eq('id', call.id);
    if (response === 'worried') {
      const { data: appointment } = await supabase.from('appointment').select('child_id').eq('id', call.appointment_id).single();
      const { data: child } = appointment ? await supabase.from('children').select('caregiver_id').eq('id', appointment.child_id).single() : { data: null };
      const { data: caregiver } = child ? await supabase.from('caregivers').select('facility_id').eq('id', child.caregiver_id).single() : { data: null };
      if (appointment && child && caregiver) {
        const { error: callbackError } = await supabase.from('callbacks').insert({ facility_id: caregiver.facility_id, child_id: appointment.child_id, call_id: call.id, source: Number(hours) === 72 ? 'worried_72h' : 'worried_24h', priority: 'urgent', status: 'open' });
        if (callbackError && callbackError.code !== '23505') throw callbackError;
      }
      if (child) await maybeDeleteCaregiverPhone(child.caregiver_id);
    } else {
      const { data: appointment } = await supabase.from('appointment').select('child_id').eq('id', call.appointment_id).single();
      const { data: child } = appointment ? await supabase.from('children').select('caregiver_id').eq('id', appointment.child_id).single() : { data: null };
      if (child) await maybeDeleteCaregiverPhone(child.caregiver_id);
    }
    vr.say({ language: language === 'ha' ? 'ha-NG' : 'en-NG' }, response === 'worried' ? 'A health worker will call you.' : 'Thank you. Goodbye.');
    vr.hangup();
    res.type('text/xml').send(vr.toString());
  } catch (error) {
    console.error('Keypad handling error:', error.message);
    const vr = new twilio.twiml.VoiceResponse(); vr.say('We could not record your response. Please contact your health facility.'); vr.hangup();
    res.type('text/xml').send(vr.toString());
  }
});

app.post('/twilio/language', verifyTwilio, async (req, res) => {
  const { callId, attemptId, hours } = req.query;
  const lang = req.body?.Digits === '1' ? 'ha' : 'en';
  try {
    const { data: attempt } = await supabase.from('call_attempts').select('keypad_sequence').eq('id', attemptId).eq('call_id', callId).single();
    if (attempt) await supabase.from('call_attempts').update({ keypad_sequence: [...(attempt.keypad_sequence || []), Number(req.body?.Digits || 2)] }).eq('id', attemptId);
    await supabase.from('calls').update({ language_code: lang }).eq('id', callId);
    const vr = new twilio.twiml.VoiceResponse();
    vr.play(`${PUBLIC_BASE_URL}/audio/call${Number(hours) === 72 ? 2 : 1}_${lang}.mp3`);
    vr.gather({ numDigits: 1, timeout: 8, actionOnEmptyResult: true, method: 'POST', action: `${PUBLIC_BASE_URL}/twilio/key?callId=${encodeURIComponent(callId)}&attemptId=${encodeURIComponent(attemptId)}&language=${lang}&hours=${hours}` });
    res.type('text/xml').send(vr.toString());
  } catch (error) { console.error('Language selection error:', error.message); fail(res, 500, 'Could not continue the call.'); }
});

app.post('/twilio/status', verifyTwilio, async (req, res) => {
  try {
    const { callId, attemptId } = req.query;
    const state = String(req.body?.CallStatus || '');
    const sid = String(req.body?.CallSid || '');
    const duration = Number.parseInt(req.body?.CallDuration, 10);
    const terminal = ['completed','busy','no-answer','failed','canceled'].includes(state);
    const outcome = ({ completed: 'answered', busy: 'busy', 'no-answer': 'no_answer', failed: 'failed', canceled: 'canceled' })[state];
    await supabase.from('call_attempts').update({ twilio_call_sid: sid || undefined, provider_status: state, ...(terminal ? { status: 'completed', outcome: outcome || 'unknown', ended_at: new Date().toISOString(), duration_seconds: Number.isFinite(duration) ? duration : null } : {}) }).eq('id', attemptId).eq('call_id', callId);
    if (terminal && state !== 'completed') {
      const { data: call } = await supabase.from('calls').select('id').eq('id', callId).single();
      await supabase.from('calls').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('id', call.id);
    }
    if (terminal) {
      const { data: call } = await supabase.from('calls').select('appointment_id').eq('id', callId).single();
      const { data: appointment } = call ? await supabase.from('appointment').select('child_id').eq('id', call.appointment_id).single() : { data: null };
      const { data: child } = appointment ? await supabase.from('children').select('caregiver_id').eq('id', appointment.child_id).single() : { data: null };
      if (child) await maybeDeleteCaregiverPhone(child.caregiver_id);
    }
    res.sendStatus(204);
  } catch (error) { console.error('Twilio status error:', error.message); res.sendStatus(204); }
});

app.get('/audio/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!/^call[12]_(?:en|ha)\.mp3$/.test(filename)) return res.sendStatus(404);
  try {
    const upstream = await fetch(`${AUDIO_BASE_URL}/${filename}`, { signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) return res.status(502).send('Audio unavailable.');
    const audio = Buffer.from(await upstream.arrayBuffer());
    if (!audio.length) return res.status(502).send('Audio unavailable.');
    res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': String(audio.length), 'Cache-Control': 'public, max-age=3600', 'Accept-Ranges': 'bytes' }).send(audio);
  } catch (error) { console.error('Audio proxy error:', error.message); res.status(502).send('Audio unavailable.'); }
});

let dispatchBusy = false;
async function dispatchDueCalls() {
  if (!CALLS_ENABLED || !AUDIO_APPROVED || !twilioClient || dispatchBusy) return;
  dispatchBusy = true;
  try {
    const { data: dueCalls, error } = await supabase.from('calls').select('*').eq('status', 'scheduled').lte('scheduled_at', new Date().toISOString()).order('scheduled_at').limit(10);
    if (error) throw error;
    for (const call of dueCalls || []) {
      const { count } = await supabase.from('call_attempts').select('id', { count: 'exact', head: true }).eq('call_id', call.id);
      if (count > 0) continue; // No retry ladder is approved for this release.
      const { data: appointment } = await supabase.from('appointment').select('id,child_id').eq('id', call.appointment_id).single();
      const { data: child } = appointment ? await supabase.from('children').select('id,caregiver_id').eq('id', appointment.child_id).single() : { data: null };
      const { data: caregiver } = child ? await supabase.from('caregivers').select('facility_id,phone,consent_given,consent_withdrawn_at,preferred_language').eq('id', child.caregiver_id).single() : { data: null };
      if (!caregiver || !caregiver.phone || !caregiver.consent_given || caregiver.consent_withdrawn_at) {
        await supabase.from('calls').update({ status: 'cancelled', completed_at: new Date().toISOString() }).eq('id', call.id);
        continue;
      }
      const { data: attempt, error: attemptError } = await supabase.from('call_attempts').insert({ call_id: call.id, attempt_number: 1, status: 'initiated' }).select('id').single();
      if (attemptError) { if (attemptError.code !== '23505') console.error('Could not create call attempt:', attemptError.message); continue; }
      try {
        const language = call.language_code === 'kr' ? 'ha' : call.language_code;
        const voiceUrl = `${PUBLIC_BASE_URL}/twilio/voice?callId=${encodeURIComponent(call.id)}&attemptId=${encodeURIComponent(attempt.id)}&language=${language}&hours=${call.follow_up_hours}`;
        const statusUrl = `${PUBLIC_BASE_URL}/twilio/status?callId=${encodeURIComponent(call.id)}&attemptId=${encodeURIComponent(attempt.id)}`;
        const dialed = await twilioClient.calls.create({ to: caregiver.phone, from: process.env.TWILIO_PHONE_NUMBER, url: voiceUrl, method: 'POST', statusCallback: statusUrl, statusCallbackMethod: 'POST', statusCallbackEvent: ['initiated','ringing','answered','completed'] });
        await supabase.from('call_attempts').update({ twilio_call_sid: dialed.sid, provider_status: dialed.status }).eq('id', attempt.id);
        await supabase.from('calls').update({ status: 'in_progress' }).eq('id', call.id);
      } catch (dialError) {
        console.error('Scheduled Twilio call failed:', dialError.message);
        await supabase.from('call_attempts').update({ status: 'completed', outcome: 'failed', provider_status: 'failed', ended_at: new Date().toISOString() }).eq('id', attempt.id);
        await supabase.from('calls').update({ status: 'failed', completed_at: new Date().toISOString() }).eq('id', call.id);
      }
    }
  } catch (error) { console.error('Due-call dispatch error:', error.message); }
  finally { dispatchBusy = false; }
}
if (CALLS_ENABLED) setInterval(dispatchDueCalls, 60000).unref();

async function retentionCleanup() {
  const now = new Date().toISOString();
  const { data: oldCallbacks } = await supabase.from('callbacks').select('id').lte('retention_expires_at', now).limit(500);
  if (oldCallbacks?.length) await supabase.from('callbacks').delete().in('id', oldCallbacks.map(x => x.id));
  const { data: oldAttempts } = await supabase.from('call_attempts').select('id').lte('retention_expires_at', now).limit(500);
  if (oldAttempts?.length) await supabase.from('call_attempts').delete().in('id', oldAttempts.map(x => x.id));
  const { data: oldCalls } = await supabase.from('calls').select('id').lte('retention_expires_at', now).limit(500);
  if (oldCalls?.length) await supabase.from('calls').delete().in('id', oldCalls.map(x => x.id));
}
setInterval(() => retentionCleanup().catch(error => console.error('Retention cleanup error:', error.message)), 6 * 60 * 60 * 1000).unref();

app.use((error, _req, res, _next) => {
  console.error('Unhandled API error:', error.message);
  fail(res, 500, 'The request could not be completed.');
});
app.use((_req, res) => fail(res, 404, 'Route not found.'));
app.listen(PORT, () => console.log(`Lafiya Line API running on ${PORT}; outbound calls ${CALLS_ENABLED && AUDIO_APPROVED ? 'enabled' : 'paused'}.`));
