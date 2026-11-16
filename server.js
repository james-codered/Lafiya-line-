'use strict'; 
// Lafiya Line API.
// The Supabase secret key stays on this server only; the browser never receives it.
// Requires Node 18+ (global fetch, AbortSignal.timeout).
const crypto = require('crypto');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */
const env = process.env;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const missingEnv = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'].filter(name => !env[name]);
if (missingEnv.length) {
  console.error('Missing required environment variables: ' + missingEnv.join(', '));
  process.exit(1);
}

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = env.SUPABASE_SECRET_KEY;
// Passwords are checked with the public (publishable/anon) key when one is provided.
const SUPABASE_AUTH_KEY = env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || SUPABASE_SECRET_KEY;
const PUBLIC_BASE_URL = (env.PUBLIC_BASE_URL || 'https://lafiya-line-voice.onrender.com').replace(/\/+$/, '');
const AUDIO_BASE_URL = (env.AUDIO_BASE_URL || 'https://elijahamosdogo-afk.github.io/Lafiya-line-/audio').replace(/\/+$/, '');
const CONSENT_VERSION = env.CONSENT_VERSION || 'consent-v1';
const CALLS_ENABLED = env.CALLS_ENABLED === 'true';
const AUDIO_APPROVED = env.AUDIO_APPROVED === 'true';
const CRON_SECRET = env.CRON_SECRET || '';
const PORT = Number(env.PORT) || 3000;
// One attempt per call unless an administrator deliberately raises this (max 3).
const MAX_ATTEMPTS = clamp(parseInt(env.CALL_MAX_ATTEMPTS, 10) || 1, 1, 3);
const RETRY_DELAY_MINUTES = clamp(parseInt(env.CALL_RETRY_DELAY_MINUTES, 10) || 60, 5, 1440);
const SCHEMA_VERSION = 'lafiya-2026-11-v1'; // must match lafiya_schema_version() in migration 002

const normalizeOrigin = value => { try { return new URL(String(value).trim()).origin; } catch (_e) { return null; } };
const FRONTEND_ORIGINS = String(env.FRONTEND_ORIGIN || 'https://elijahamosdogo-afk.github.io')
  .split(',').map(normalizeOrigin).filter(Boolean);

const supabaseOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, supabaseOptions);
const authClient = () => createClient(SUPABASE_URL, SUPABASE_AUTH_KEY, supabaseOptions);

const twilioConfigured = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
const twilioClient = twilioConfigured ? twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN) : null;
const callingReady = () => CALLS_ENABLED && AUDIO_APPROVED && twilioConfigured;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const fail = (res, status, message, extra) => res.status(status).json({ error: message, ...(extra || {}) });
const route = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const must = result => { if (result.error) throw result.error; return result.data; };
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const cleanText = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Logs never contain phone numbers or email addresses (Postgres error details can echo them).
const redact = value => String(value == null ? '' : value)
  .replace(/\+?234\d{9,10}/g, '[phone]').replace(/\b0[789]\d{9}\b/g, '[phone]')
  .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]').slice(0, 400);
function logError(tag, error, extra) {
  const e = error || {};
  console.error(`[${tag}]`, JSON.stringify({
    code: e.code || undefined, message: redact(e.message), details: redact(e.details), hint: redact(e.hint),
    step: e.step || undefined, ...(extra || {})
  }));
}

function mapDbError(error) {
  if (!error) return null;
  const text = String(error.message || '');
  const known = {
    CONSENT_REQUIRED: [400, 'Record the caregiver’s verbal consent before scheduling calls.'],
    NAME_REQUIRED: [400, 'Enter the caregiver’s full name.'],
    DUPLICATE_ENROLMENT: [409, 'This child was just enrolled. Open the existing record instead of enrolling again.'],
    DUPLICATE_DOSE: [409, 'This dose stage is already recorded for this child.'],
    STAGE_OUT_OF_ORDER: [409, 'This dose comes before a dose that is already recorded for this child.'],
    SCHEDULE_COMPLETE: [409, 'This child’s vaccination schedule is already complete.'],
    CHILD_NOT_FOUND: [404, 'Child not found at your facility.']
  };
  for (const [key, [status, message]] of Object.entries(known)) if (text.startsWith(key)) return { status, message };
  if (error.code === 'PGRST202' || error.code === '42883') return { status: 503, message: 'The database is missing the latest Lafiya Line migration. Ask the system administrator to apply it.' };
  if (['42703', '42P01', 'PGRST204', 'PGRST205'].includes(error.code)) return { status: 503, message: 'The database structure is out of date. Ask the system administrator to apply the latest migrations.' };
  if (error.code === '23505') return { status: 409, message: 'That record already exists.' };
  if (error.code === '23503') return { status: 400, message: 'A linked record could not be found.' };
  if (error.code === '23514' || error.code === '22P02') return { status: 400, message: 'Some of the information is not valid.' };
  return null;
}

// Fixed-window counters for rate limiting (single instance, in memory).
function makeCounter(windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [key, v] of hits) if (v.reset <= now) hits.delete(key); }, windowMs).unref();
  return {
    get(key) { const v = hits.get(key); return v && v.reset > Date.now() ? v.count : 0; },
    add(key) { const now = Date.now(); const v = hits.get(key); if (!v || v.reset <= now) { hits.set(key, { count: 1, reset: now + windowMs }); return 1; } v.count += 1; return v.count; },
    clear(key) { hits.delete(key); }
  };
}
const loginFailuresByIp = makeCounter(15 * 60 * 1000);
const loginFailuresByEmail = makeCounter(15 * 60 * 1000);
const apiRequests = makeCounter(60 * 1000);
const staffCreations = makeCounter(60 * 60 * 1000);

/* ------------------------------------------------------------------ */
/* Dates, phones and the vaccination schedule (all Africa/Lagos)        */
/* ------------------------------------------------------------------ */
const lagosFormat = (date, options) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hourCycle: 'h23', ...options });
function lagosParts(date = new Date()) {
  const parts = {};
  lagosFormat(date, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(date).forEach(p => { parts[p.type] = p.value; });
  return parts;
}
const lagosDate = (date = new Date()) => { const p = lagosParts(date); return `${p.year}-${p.month}-${p.day}`; };
const lagosMinutes = (date = new Date()) => { const p = lagosParts(date); return Number(p.hour) * 60 + Number(p.minute); };
const withinCallWindow = (date = new Date()) => { const m = lagosMinutes(date); return m >= 420 && m <= 1200; }; // 07:00-20:00
function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const addDaysIso = (dateString, days) => {
  const [y, m, d] = dateString.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const lagosNoonIso = dateString => new Date(`${dateString}T12:00:00+01:00`).toISOString(); // Lagos is UTC+1, no DST

// Target time = vaccination time + hours, moved into the 07:00-20:00 Lagos calling window.
function scheduledAt(vaccinatedAt, hours) {
  const target = new Date(new Date(vaccinatedAt).getTime() + hours * 3600000);
  const local = new Date(target.getTime() + 3600000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes() + local.getUTCSeconds() / 60 + local.getUTCMilliseconds() / 60000;
  if (minutes >= 420 && minutes <= 1200) return target.toISOString();
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + (minutes > 1200 ? 1 : 0), 7));
  return new Date(day.getTime() - 3600000).toISOString();
}
const callSchedule = vaccinatedAtIso => [24, 72].map(hours => ({ hours, at: scheduledAt(vaccinatedAtIso, hours) }));

function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  let n = value.replace(/[\s().-]/g, '');
  if (/^\+?2340[789]\d{9}$/.test(n)) n = n.replace(/^\+?2340/, '+234');   // +234 0803... typed with the trunk zero
  else if (/^234[789]\d{9}$/.test(n)) n = '+' + n;
  else if (/^0[789]\d{9}$/.test(n)) n = '+234' + n.slice(1);
  return /^\+234[789]\d{9}$/.test(n) ? n : null;
}

const stageMap = {
  'Birth': ['Birth - BCG', '6 weeks - Rotavirus'], '6 weeks': ['6 weeks - Rotavirus', '10 weeks - Rotavirus'],
  '10 weeks': ['10 weeks - Rotavirus', '14 weeks - Rotavirus'], '14 weeks': ['14 weeks - Rotavirus', '9 months - Nine-month'],
  '9 months': ['9 months - Nine-month', '15 months - Nine-month'], '15 months': ['15 months - Nine-month', null]
};
const languageMap = { English: 'en', Hausa: 'ha', Kanuri: 'kr', en: 'en', ha: 'ha', kr: 'kr' };

function validateNextDose(dose, nextDoseDate) {
  if (dose === '15 months') return null; // final dose: no next dose
  if (!isRealDate(nextDoseDate)) return 'Choose a valid date for the next dose.';
  const today = lagosDate();
  if (nextDoseDate <= today) return 'Choose a future date for the next dose.';
  if (nextDoseDate > addDaysIso(today, 800)) return 'The next dose date is too far in the future.';
  return null;
}

/* ------------------------------------------------------------------ */
/* Reading lots of rows safely (1,000-row pages, short .in() lists)     */
/* ------------------------------------------------------------------ */
async function fetchAll(makeQuery) {
  const rows = [], size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await makeQuery().range(from, from + size - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < size) return rows;
  }
}
function sortRows(rows, order) {
  if (!order) return rows;
  const dir = order.ascending === false ? -1 : 1;
  return rows.sort((a, b) => {
    const x = a[order.column], y = b[order.column];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}
async function fetchIn(table, columns, column, ids, order) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100);
    out.push(...await fetchAll(() => {
      let q = supabase.from(table).select(columns).in(column, slice);
      if (order) q = q.order(order.column, { ascending: order.ascending !== false, nullsFirst: false });
      return q.order('id');
    }));
  }
  return sortRows(out, order);
}
const step = async (label, fn) => { try { return await fn(); } catch (error) { if (error && typeof error === 'object') error.step = label; throw error; } };

/* ------------------------------------------------------------------ */
/* Express app, CORS and request limits                                 */
/* ------------------------------------------------------------------ */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && FRONTEND_ORIGINS.includes(origin)) res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Max-Age', '600');
  res.set('X-Content-Type-Options', 'nosniff');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use('/api', (req, res, next) => (apiRequests.add(req.ip) > 300 ? fail(res, 429, 'Too many requests. Please wait a moment.') : next()));

/* ------------------------------------------------------------------ */
/* Authentication and access control                                    */
/* ------------------------------------------------------------------ */
const ROLES = ['system_admin', 'facility_admin', 'health_worker'];
const facilityCache = new Map();
async function facilityIsActive(facilityId) {
  const hit = facilityCache.get(facilityId);
  if (hit && hit.until > Date.now()) return hit.active;
  const data = must(await supabase.from('facilities').select('id,is_active').eq('id', facilityId).maybeSingle());
  const active = Boolean(data && data.is_active !== false);
  facilityCache.set(facilityId, { active, until: Date.now() + 30000 });
  return active;
}
const hasFacility = (profile, facilityId) => Boolean(facilityId) && (profile.role === 'system_admin' || profile.facility_id === facilityId);

async function loadProfile(userId) {
  return must(await supabase.from('profiles').select('id,facility_id,role,full_name,is_active').eq('id', userId).maybeSingle());
}
// Returns null when the account may use the app, otherwise the reason it may not.
async function accountProblem(profile) {
  if (!profile || !profile.is_active) return 'This account is not active in Lafiya Line.';
  if (!ROLES.includes(profile.role)) return 'This account has no valid Lafiya Line role.';
  if (profile.role !== 'system_admin') {
    // Only system administrators may have no facility.
    if (!profile.facility_id) return 'This account is not assigned to a facility. Contact the system administrator.';
    if (!await facilityIsActive(profile.facility_id)) return 'Your facility is inactive. Contact the system administrator.';
  }
  return null;
}

const requireAuth = async (req, res, next) => {
  try {
    const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    if (!match) return fail(res, 401, 'Please sign in again.');
    const { data: authData, error: authError } = await supabase.auth.getUser(match[1]);
    if (authError || !authData || !authData.user) return fail(res, 401, 'Your sign-in has expired. Please sign in again.');
    const profile = await loadProfile(authData.user.id);
    const problem = await accountProblem(profile);
    if (problem) return fail(res, 403, problem);
    req.user = authData.user;
    req.profile = profile;
    next();
  } catch (error) {
    logError('auth', error);
    fail(res, 503, 'Could not verify your sign-in. Please try again.');
  }
};
const staff = (...roles) => (req, res, next) => (roles.includes(req.profile.role) ? next() : fail(res, 403, 'You do not have permission to do that.'));
const STAFF_ROLES = ['system_admin', 'facility_admin', 'health_worker'];

/* ------------------------------------------------------------------ */
/* Health and diagnostics                                               */
/* ------------------------------------------------------------------ */
// Every table/column the API reads or writes. Used only for diagnostics.
const SCHEMA_PROBES = {
  facilities: 'id,name,code,address,phone,is_active',
  profiles: 'id,facility_id,role,full_name,phone,is_active,created_at',
  caregivers: 'id,facility_id,full_name,phone,preferred_language,consent_given,consent_given_at,consent_withdrawn_at,consent_version,referred_by,created_at',
  children: 'id,caregiver_id,facility_id,age_value,age_unit,enrolled_at,estimated_date_of_birth,is_active',
  appointment: 'id,child_id,vaccine_type,vaccinated_at,next_dose_stage,next_dose_due_at,schedule_complete,schedule_completed_at,recorded_by',
  calls: 'id,appointment_id,follow_up_hours,scheduled_at,language_code,status,completed_at,retention_expires_at',
  call_attempts: 'id,call_id,attempt_number,status,twilio_call_sid,provider_status,keypad_sequence,response,outcome,started_at,ended_at,duration_seconds,retention_expires_at',
  callbacks: 'id,facility_id,caregiver_id,child_id,call_id,source,priority,status,description,created_by,assigned_to,resolution,called_back_at,completed_at,retention_expires_at,'
    + 'danger_stopped_feeding,danger_fits_or_shaking,danger_vomiting_everything,danger_unusually_sleepy_or_hard_to_wake,danger_fast_or_difficult_breathing,danger_yellow_eyes_or_skin,danger_injection_site_large_hot_or_pus'
};
async function schemaProblems() {
  const problems = [];
  for (const [table, columns] of Object.entries(SCHEMA_PROBES)) {
    const { error } = await supabase.from(table).select(columns).limit(1);
    if (error) problems.push({ table, code: error.code || null, message: String(error.message || '').slice(0, 200) });
  }
  const { data, error } = await supabase.rpc('lafiya_schema_version');
  if (error) problems.push({ table: 'functions', code: error.code || null, message: 'Migration 002 is not applied (lafiya_schema_version missing).' });
  else if (data !== SCHEMA_VERSION) problems.push({ table: 'functions', code: null, message: `Database schema version is ${data}; the server expects ${SCHEMA_VERSION}.` });
  return problems;
}

app.get('/', (_req, res) => res.send('Lafiya Line API is running.'));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/db-check', route(async (_req, res) => {
  const { error } = await supabase.from('facilities').select('id').limit(1);
  if (error) { logError('db-check', error); return fail(res, 503, 'Database connection failed.'); }
  let schemaReady = false;
  try { schemaReady = (await schemaProblems()).length === 0; } catch (e) { logError('db-check-schema', e); }
  res.json({ connected: true, schemaReady });
}));
app.get('/api/system/status', requireAuth, staff('system_admin'), route(async (_req, res) => {
  const problems = await schemaProblems();
  res.json({
    schemaReady: problems.length === 0, problems, expectedSchemaVersion: SCHEMA_VERSION,
    callsEnabled: CALLS_ENABLED, audioApproved: AUDIO_APPROVED, twilioConfigured, callingReady: callingReady(),
    maxAttempts: MAX_ATTEMPTS, cronSecretSet: Boolean(CRON_SECRET), frontendOrigins: FRONTEND_ORIGINS
  });
}));

/* ------------------------------------------------------------------ */
/* Login                                                                */
/* ------------------------------------------------------------------ */
app.post('/api/auth/login', route(async (req, res) => {
  const email = cleanText(req.body && req.body.email, 200).toLowerCase();
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
  if (!email || !password || password.length > 200) return fail(res, 400, 'Enter your work email and password.');
  if (loginFailuresByIp.get(req.ip) >= 30 || loginFailuresByEmail.get(email) >= 8) {
    return fail(res, 429, 'Too many failed sign-in attempts. Please wait 15 minutes and try again.');
  }
  const { data, error } = await authClient().auth.signInWithPassword({ email, password });
  if (error || !data || !data.session || !data.user) {
    if (error && (!error.status || error.status >= 500)) { logError('login', error); return fail(res, 503, 'Sign-in is temporarily unavailable.'); }
    loginFailuresByIp.add(req.ip); loginFailuresByEmail.add(email);
    return fail(res, 401, 'Email or password is incorrect.');
  }
  loginFailuresByEmail.clear(email);
  let profile;
  try { profile = await loadProfile(data.user.id); } catch (e) { logError('login-profile', e); return fail(res, 503, 'Sign-in is temporarily unavailable.'); }
  let problem;
  try { problem = await accountProblem(profile); } catch (e) { logError('login-facility', e); return fail(res, 503, 'Sign-in is temporarily unavailable.'); }
  if (problem) return fail(res, 403, problem);
  res.json({ access_token: data.session.access_token, expires_in: data.session.expires_in, user: profile });
}));
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.profile }));

/* ------------------------------------------------------------------ */
/* Bootstrap: one facility-scoped snapshot for the dashboard             */
/* ------------------------------------------------------------------ */
async function authEmails(ids) {
  const wanted = new Set(ids), found = {};
  for (let page = 1; page <= 20 && wanted.size; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = (data && data.users) || [];
    users.forEach(u => { if (wanted.has(u.id)) found[u.id] = u.email; });
    if (users.length < 1000) break;
  }
  return found;
}

app.get('/api/bootstrap', requireAuth, async (req, res) => {
  const ref = crypto.randomBytes(3).toString('hex');
  try {
    const p = req.profile;
    const facilities = await step('facilities', () => fetchAll(() => {
      let q = supabase.from('facilities').select('*').order('name').order('id');
      if (p.role !== 'system_admin') q = q.eq('id', p.facility_id);
      return q;
    }));
    const callingReadyNow = callingReady();
    const facilityIds = facilities.map(x => x.id);
    if (!facilityIds.length) {
      return res.json({ user: p, facilities: [], caregivers: [], children: [], appointments: [], calls: [], attempts: [], callbacks: [], profiles: [], callingReady: callingReadyNow });
    }
    const caregivers = await step('caregivers', () => fetchIn('caregivers', '*', 'facility_id', facilityIds, { column: 'created_at', ascending: false }));
    const callbacks = await step('callbacks', () => fetchIn('callbacks', '*', 'facility_id', facilityIds, { column: 'created_at', ascending: false }));
    const profileRows = await step('profiles', () => fetchIn('profiles', 'id,facility_id,role,full_name,phone,is_active,created_at', 'facility_id', facilityIds));
    // System administrators have no facility, so they are not matched by the facility filter above.
    if (p.role === 'system_admin') {
      const admins = await step('admin-profiles', () => fetchAll(() => supabase.from('profiles').select('id,facility_id,role,full_name,phone,is_active,created_at').is('facility_id', null).order('id')));
      profileRows.push(...admins);
    }
    const cgIds = caregivers.map(x => x.id);
    const children = cgIds.length ? await step('children', () => fetchIn('children', '*', 'caregiver_id', cgIds)) : [];
    const childIds = children.map(x => x.id);
    const appointments = childIds.length ? await step('appointment', () => fetchIn('appointment', '*', 'child_id', childIds, { column: 'vaccinated_at', ascending: false })) : [];
    const apptIds = appointments.map(x => x.id);
    const calls = apptIds.length ? await step('calls', () => fetchIn('calls', '*', 'appointment_id', apptIds, { column: 'scheduled_at', ascending: false })) : [];
    const callIds = calls.map(x => x.id);
    const attempts = callIds.length ? await step('call_attempts', () => fetchIn('call_attempts', '*', 'call_id', callIds, { column: 'attempt_number', ascending: true })) : [];
    let emails = {};
    try { emails = await authEmails(profileRows.map(x => x.id)); } catch (e) { logError('bootstrap-emails', e); }
    const profiles = profileRows.map(x => ({ ...x, email: emails[x.id] || null }));
    res.json({ user: p, facilities, caregivers, children, appointments, calls, attempts, callbacks, profiles, callingReady: callingReadyNow });
  } catch (error) {
    logError('bootstrap', error, { ref, role: req.profile && req.profile.role });
    fail(res, 503, 'Could not load your facility records.', { ref });
  }
});

/* ------------------------------------------------------------------ */
/* Phone retention: a number is removed only when nothing depends on it  */
/* ------------------------------------------------------------------ */
// Returns a reason the number must be kept, or null if it may be deleted.
// Any database error is thrown, so a failed check can never lead to a deletion.
async function phoneDeletionBlocker(caregiverId, { requireChildren }) {
  const children = must(await supabase.from('children').select('id,is_active').eq('caregiver_id', caregiverId));
  if (!children.length) return requireChildren ? 'No enrolled child.' : null;
  if (children.some(c => c.is_active !== false)) return 'A child is still enrolled.';
  const childIds = children.map(c => c.id);
  const appointments = await fetchIn('appointment', 'id,child_id,schedule_complete', 'child_id', childIds);
  for (const id of childIds) {
    if (!appointments.some(a => a.child_id === id && a.schedule_complete === true)) return 'A child still has scheduled doses.';
  }
  const apptIds = appointments.map(a => a.id);
  const calls = apptIds.length ? await fetchIn('calls', 'id,status', 'appointment_id', apptIds) : [];
  if (calls.some(c => ['scheduled', 'in_progress'].includes(c.status))) return 'A follow-up call is still scheduled.';
  const callbacks = await fetchIn('callbacks', 'id,status', 'child_id', childIds);
  if (callbacks.some(c => !['completed', 'cancelled'].includes(c.status))) return 'A callback task is still open.';
  return null;
}
async function maybeDeleteCaregiverPhone(caregiverId) {
  try {
    if (await phoneDeletionBlocker(caregiverId, { requireChildren: true })) return false;
    const { error } = await supabase.from('caregivers').update({ phone: null }).eq('id', caregiverId).not('phone', 'is', null);
    if (error) throw error;
    return true;
  } catch (error) { logError('phone-retention', error); return false; }
}

/* ------------------------------------------------------------------ */
/* Registration and vaccinations (atomic database functions)            */
/* ------------------------------------------------------------------ */
async function loadChildForStaff(profile, childId) {
  if (!isUuid(childId)) return null;
  const child = must(await supabase.from('children').select('id,caregiver_id').eq('id', childId).maybeSingle());
  if (!child) return null;
  const caregiver = must(await supabase.from('caregivers').select('id,facility_id,consent_given,consent_withdrawn_at,preferred_language,phone').eq('id', child.caregiver_id).maybeSingle());
  if (!caregiver || !hasFacility(profile, caregiver.facility_id)) return null;
  return { child, caregiver };
}
const consentActive = caregiver => Boolean(caregiver.consent_given && !caregiver.consent_withdrawn_at);

app.post('/api/register', requireAuth, staff(...STAFF_ROLES), route(async (req, res) => {
  const p = req.profile;
  const b = req.body || {};
  const facilityId = p.role === 'system_admin' ? b.facilityId : p.facility_id;
  if (!isUuid(facilityId) || !hasFacility(p, facilityId)) return fail(res, 403, 'Choose a facility assigned to your account.');
  if (!await facilityIsActive(facilityId)) return fail(res, 400, 'That facility is not active.');
  const phone = normalizePhone(b.phone);
  const languageCode = languageMap[b.language];
  const age = Number(b.age);
  const stage = Object.prototype.hasOwnProperty.call(stageMap, b.dose) ? stageMap[b.dose] : null;
  const fullName = cleanText(b.fullName, 120);
  const referredBy = cleanText(b.referredBy, 100);
  if (!phone) return fail(res, 400, 'Enter a valid Nigerian phone number.');
  if (!languageCode) return fail(res, 400, 'Choose English, Hausa or Kanuri.');
  if (!['weeks', 'months'].includes(b.ageUnit) || !Number.isInteger(age) || age < 0 || age > (b.ageUnit === 'weeks' ? 104 : 59)) return fail(res, 400, 'Enter a valid age in weeks or months.');
  if (!stage) return fail(res, 400, 'Choose the dose given today.');
  if (fullName.length < 2) return fail(res, 400, 'Enter the caregiver’s full name.');
  const doseProblem = validateNextDose(b.dose, b.nextDoseDate);
  if (doseProblem) return fail(res, 400, doseProblem);

  const isFinalDose = b.dose === '15 months';
  const now = new Date();
  const today = lagosDate(now);
  let saved;
  try {
    saved = must(await supabase.rpc('lafiya_register_enrolment', {
      p_facility_id: facilityId, p_full_name: fullName, p_phone: phone, p_language_code: languageCode, p_referred_by: referredBy || null,
      p_consent_given: b.consentGiven === true, p_consent_version: CONSENT_VERSION,
      p_age_value: age, p_age_unit: b.ageUnit, p_enrolled_at: today,
      p_estimated_dob: addDaysIso(today, -Math.round(age * (b.ageUnit === 'weeks' ? 7 : 30.4375))),
      p_vaccine_type: stage[0], p_next_dose_stage: isFinalDose ? null : stage[1],
      p_next_dose_due_at: isFinalDose ? null : lagosNoonIso(b.nextDoseDate),
      p_schedule_complete: isFinalDose, p_recorded_by: p.id, p_vaccinated_at: now.toISOString(),
      p_call_schedule: callSchedule(now.toISOString())
    }));
  } catch (error) {
    const mapped = mapDbError(error);
    logError('register', error, { mapped: Boolean(mapped) });
    if (mapped) return fail(res, mapped.status, mapped.message);
    return fail(res, 500, 'Could not save this enrolment.');
  }
  if (isFinalDose) await maybeDeleteCaregiverPhone(saved.caregiver_id);
  res.status(201).json({ success: true, caregiver_id: saved.caregiver_id, child_id: saved.child_id, appointment_id: saved.appointment_id, call_ids: saved.call_ids || [] });
}));

app.post('/api/vaccinations', requireAuth, staff(...STAFF_ROLES), route(async (req, res) => {
  const { childId, dose, nextDoseDate } = req.body || {};
  const stage = Object.prototype.hasOwnProperty.call(stageMap, dose) ? stageMap[dose] : null;
  if (!stage) return fail(res, 400, 'Choose the dose given today.');
  const doseProblem = validateNextDose(dose, nextDoseDate);
  if (doseProblem) return fail(res, 400, doseProblem);
  const found = await loadChildForStaff(req.profile, childId);
  if (!found) return fail(res, 404, 'Child not found at your facility.');
  const { child, caregiver } = found;
  const active = consentActive(caregiver);
  if (!caregiver.phone && active) return fail(res, 409, 'This caregiver’s number has been deleted; update the record before continuing.');
  const isFinalDose = dose === '15 months';
  const now = new Date();
  let saved;
  try {
    saved = must(await supabase.rpc('create_aftercare_vaccination', {
      p_child_id: child.id, p_vaccine_type: stage[0], p_vaccinated_at: now.toISOString(),
      p_next_dose_stage: isFinalDose ? null : stage[1], p_next_dose_due_at: isFinalDose ? null : lagosNoonIso(nextDoseDate),
      p_schedule_complete: isFinalDose, p_schedule_completed_at: isFinalDose ? now.toISOString() : null,
      p_recorded_by: req.profile.id, p_language_code: caregiver.preferred_language,
      p_create_calls: Boolean(caregiver.phone && active), p_call_schedule: callSchedule(now.toISOString())
    }));
  } catch (error) {
    const mapped = mapDbError(error);
    logError('vaccination', error, { mapped: Boolean(mapped) });
    if (mapped) return fail(res, mapped.status, mapped.message);
    return fail(res, 500, 'Could not save this vaccination.');
  }
  if (isFinalDose) await maybeDeleteCaregiverPhone(caregiver.id);
  res.status(201).json({ success: true, appointment_id: saved.appointment_id, call_ids: saved.call_ids || [] });
}));

// Vaccination history is retained exactly as entered; this route does not overwrite it.
app.patch('/api/appointments/:id', requireAuth, staff(...STAFF_ROLES), route(async (_req, res) => {
  fail(res, 501, 'Vaccination records cannot be edited in this version. Record a new dose instead.');
}));

/* ------------------------------------------------------------------ */
/* Caregivers: edit, consent withdrawal / restoration, number deletion   */
/* ------------------------------------------------------------------ */
app.patch('/api/caregivers/:id', requireAuth, staff(...STAFF_ROLES), route(async (req, res) => {
  if (!isUuid(req.params.id)) return fail(res, 404, 'Caregiver record not found.');
  const caregiver = must(await supabase.from('caregivers').select('*').eq('id', req.params.id).maybeSingle());
  if (!caregiver || !hasFacility(req.profile, caregiver.facility_id)) return fail(res, 404, 'Caregiver record not found.');
  const b = req.body || {};
  const updates = {};
  if (b.phone !== undefined) {
    const phone = normalizePhone(b.phone);
    if (!phone) return fail(res, 400, 'Enter a valid Nigerian phone number.');
    updates.phone = phone;
  }
  if (b.language !== undefined) {
    const code = languageMap[b.language];
    if (!code) return fail(res, 400, 'Choose English, Hausa or Kanuri.');
    updates.preferred_language = code; updates.language = b.language in { English: 1, Hausa: 1, Kanuri: 1 } ? b.language : undefined;
    if (updates.language === undefined) delete updates.language;
  }
  if (b.referredBy !== undefined) updates.referred_by = cleanText(b.referredBy, 100) || null;
  const withdrawing = b.withdrawConsent === true && caregiver.consent_given && !caregiver.consent_withdrawn_at;
  if (withdrawing) Object.assign(updates, { consent_given: false, consent: false, consent_withdrawn_at: new Date().toISOString() });
  if (b.restoreConsent === true && !withdrawing && (!caregiver.consent_given || caregiver.consent_withdrawn_at)) {
    Object.assign(updates, { consent_given: true, consent: true, consent_given_at: new Date().toISOString(), consent_withdrawn_at: null, consent_version: CONSENT_VERSION });
  }
  if (b.deletePhone === true) {
    let blocker;
    try { blocker = await phoneDeletionBlocker(caregiver.id, { requireChildren: false }); }
    catch (error) { logError('delete-phone-check', error); return fail(res, 503, 'Could not confirm it is safe to delete this number. Nothing was deleted.'); }
    if (blocker) return fail(res, 409, 'The number is kept for now. ' + blocker);
    updates.phone = null;
  }
  if (!Object.keys(updates).length) return fail(res, 400, 'No supported changes were provided.');
  let saved;
  try {
    saved = must(await supabase.from('caregivers').update(updates).eq('id', caregiver.id)
      .select('id,phone,preferred_language,consent_given,consent_withdrawn_at,referred_by').single());
  } catch (error) {
    if (error.code === '23505') return fail(res, 409, 'Another caregiver at this facility already uses that number.');
    throw error;
  }
  if (withdrawing) {
    try {
      const children = must(await supabase.from('children').select('id').eq('caregiver_id', caregiver.id));
      const appointments = children.length ? await fetchIn('appointment', 'id', 'child_id', children.map(x => x.id)) : [];
      const calls = appointments.length ? await fetchIn('calls', 'id,status', 'appointment_id', appointments.map(x => x.id)) : [];
      const pending = calls.filter(c => c.status === 'scheduled').map(c => c.id);
      for (let i = 0; i < pending.length; i += 100) {
        must(await supabase.from('calls').update({ status: 'cancelled', completed_at: new Date().toISOString() }).in('id', pending.slice(i, i + 100)).eq('status', 'scheduled'));
      }
    } catch (error) { logError('withdraw-cancel-calls', error); } // the dispatcher re-checks consent, so no call can be placed
  }
  res.json({ success: true, caregiver: saved });
}));

/* ------------------------------------------------------------------ */
/* Callbacks                                                            */
/* ------------------------------------------------------------------ */
// frontend key, API alias, database column
const DANGER_SIGNS = [
  ['feeding', 'stopped_feeding', 'danger_stopped_feeding'], ['convulsion', 'fits_or_shaking', 'danger_fits_or_shaking'],
  ['vomiting', 'vomiting_everything', 'danger_vomiting_everything'], ['sleepy', 'unusually_sleepy_or_hard_to_wake', 'danger_unusually_sleepy_or_hard_to_wake'],
  ['breathing', 'fast_or_difficult_breathing', 'danger_fast_or_difficult_breathing'], ['yellow', 'yellow_eyes_or_skin', 'danger_yellow_eyes_or_skin'],
  ['site', 'injection_site_large_hot_or_pus', 'danger_injection_site_large_hot_or_pus']
];
const RESOLUTIONS = { Reassured: 'reassured', 'Come in today': 'come_in_today', Escalated: 'escalated' };

app.patch('/api/callbacks/:id', requireAuth, staff(...STAFF_ROLES), route(async (req, res) => {
  if (!isUuid(req.params.id)) return fail(res, 404, 'Callback task not found.');
  const existing = must(await supabase.from('callbacks').select('*').eq('id', req.params.id).maybeSingle());
  if (!existing || !hasFacility(req.profile, existing.facility_id)) return fail(res, 404, 'Callback task not found.');
  if (['completed', 'cancelled'].includes(existing.status)) return fail(res, 409, 'This callback task is already closed.');
  const b = req.body || {};
  const updates = {};
  if (b.dangerSigns !== undefined) {
    if (!Array.isArray(b.dangerSigns)) return fail(res, 400, 'Danger signs must be a list.');
    const selected = new Set();
    for (const sign of b.dangerSigns) {
      const entry = DANGER_SIGNS.find(([key, alias]) => sign === key || sign === alias);
      if (!entry) return fail(res, 400, 'Unknown danger sign.');
      selected.add(entry[2]);
    }
    DANGER_SIGNS.forEach(([, , column]) => { updates[column] = selected.has(column); });
  }
  if (b.resolution !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(RESOLUTIONS, b.resolution)) return fail(res, 400, 'Choose a callback outcome.');
    updates.resolution = RESOLUTIONS[b.resolution];
  }
  if (b.assignTo !== undefined) {
    if (b.assignTo === null) { updates.assigned_to = null; if (existing.status === 'assigned') updates.status = 'open'; }
    else {
      if (!isUuid(b.assignTo)) return fail(res, 400, 'The selected worker must be active at this facility.');
      const assignee = must(await supabase.from('profiles').select('id,facility_id,role,is_active').eq('id', b.assignTo).maybeSingle());
      if (!assignee || !assignee.is_active || assignee.facility_id !== existing.facility_id || !['health_worker', 'facility_admin'].includes(assignee.role)) return fail(res, 400, 'The selected worker must be active at this facility.');
      updates.assigned_to = assignee.id; updates.status = 'assigned';
    }
  }
  if (b.complete === true) {
    if (!existing.resolution && !updates.resolution) return fail(res, 400, 'Choose an outcome before completing the callback.');
    const now = new Date().toISOString();
    Object.assign(updates, { status: 'completed', completed_at: now, called_back_at: now }); // completing wins over assigning
  }
  if (!Object.keys(updates).length) return fail(res, 400, 'No supported changes were provided.');
  const data = must(await supabase.from('callbacks').update(updates).eq('id', existing.id).in('status', ['open', 'assigned']).select('*').maybeSingle());
  if (!data) return fail(res, 409, 'This callback task changed or was closed. Refresh and try again.');
  if (updates.status === 'completed' && existing.child_id) {
    const child = must(await supabase.from('children').select('caregiver_id').eq('id', existing.child_id).maybeSingle());
    if (child) await maybeDeleteCaregiverPhone(child.caregiver_id);
  }
  res.json({ success: true, callback: data });
}));

app.post('/api/callbacks', requireAuth, staff(...STAFF_ROLES), route(async (req, res) => {
  const found = await loadChildForStaff(req.profile, req.body && req.body.childId);
  if (!found) return fail(res, 404, 'Child not found at your facility.');
  const description = cleanText(req.body.description, 500) || null;
  // A double-tap creates one task, not two.
  const recent = must(await supabase.from('callbacks').select('*').eq('child_id', found.child.id).eq('source', 'manual').eq('created_by', req.profile.id)
    .gte('created_at', new Date(Date.now() - 60000).toISOString()).limit(1));
  if (recent.length) return res.status(200).json({ success: true, callback: recent[0] });
  const data = must(await supabase.from('callbacks').insert({
    facility_id: found.caregiver.facility_id, caregiver_id: found.caregiver.id, child_id: found.child.id, call_id: null, source: 'manual',
    priority: 'normal', status: 'open', description, reason: 'Manual callback', created_by: req.profile.id
  }).select('*').single());
  res.status(201).json({ success: true, callback: data });
}));

/* ------------------------------------------------------------------ */
/* Staff and facilities                                                 */
/* ------------------------------------------------------------------ */
app.post('/api/users', requireAuth, route(async (req, res) => {
  const actor = req.profile;
  const { email, password, fullName, phone, role, facilityId } = req.body || {};
  const allowedRole = actor.role === 'system_admin' ? role === 'facility_admin' : actor.role === 'facility_admin' && role === 'health_worker';
  const facility = actor.role === 'system_admin' ? facilityId : actor.facility_id;
  if (!allowedRole || !isUuid(facility) || !hasFacility(actor, facility)) return fail(res, 403, 'System admins create facility admins; facility admins create health workers in their own facility.');
  const cleanEmail = cleanText(email, 200).toLowerCase();
  const name = cleanText(fullName, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || typeof password !== 'string' || password.length < 12 || password.length > 200 || name.length < 2) {
    return fail(res, 400, 'Provide a valid email, a password of at least 12 characters, and the staff member’s name.');
  }
  let staffPhone = null;
  if (cleanText(phone, 30)) { staffPhone = normalizePhone(phone); if (!staffPhone) return fail(res, 400, 'Enter a valid Nigerian phone number.'); }
  if (!await facilityIsActive(facility)) return fail(res, 400, 'That facility is not active.');
  if (staffCreations.add(req.user.id) > 20) return fail(res, 429, 'Too many accounts created. Please try again later.');
  let newUserId;
  try {
    const { data: created, error: createError } = await supabase.auth.admin.createUser({ email: cleanEmail, password, email_confirm: true });
    if (createError) throw createError;
    newUserId = created.user.id;
    const profile = must(await supabase.from('profiles').insert({ id: newUserId, facility_id: facility, role, full_name: name, phone: staffPhone, is_active: true })
      .select('id,facility_id,role,full_name,phone,is_active').single());
    res.status(201).json({ success: true, profile });
  } catch (error) {
    if (newUserId) {
      const { error: cleanupError } = await supabase.auth.admin.deleteUser(newUserId);
      if (cleanupError) logError('staff-cleanup', cleanupError, { note: 'auth user left without a profile' });
    }
    logError('staff-create', error);
    fail(res, 400, 'Could not create this staff account. Check whether the email is already used.');
  }
}));

// Deactivate or reactivate a staff account. Deactivated staff are refused on their next request.
app.patch('/api/users/:id', requireAuth, route(async (req, res) => {
  const actor = req.profile;
  if (!isUuid(req.params.id) || typeof (req.body && req.body.isActive) !== 'boolean') return fail(res, 400, 'Provide isActive as true or false.');
  if (req.params.id === actor.id) return fail(res, 400, 'You cannot change your own account status.');
  const target = must(await supabase.from('profiles').select('id,facility_id,role').eq('id', req.params.id).maybeSingle());
  const allowed = target && ((actor.role === 'system_admin' && target.role !== 'system_admin')
    || (actor.role === 'facility_admin' && target.role === 'health_worker' && target.facility_id === actor.facility_id));
  if (!allowed) return fail(res, 404, 'Staff account not found.');
  const profile = must(await supabase.from('profiles').update({ is_active: req.body.isActive }).eq('id', target.id).select('id,facility_id,role,full_name,is_active').single());
  res.json({ success: true, profile });
}));

app.post('/api/facilities', requireAuth, staff('system_admin'), route(async (req, res) => {
  const { name, code, phone, address } = req.body || {};
  const normalizedPhone = normalizePhone(phone);
  const cleanName = cleanText(name, 150), cleanCode = cleanText(code, 40);
  if (cleanName.length < 2 || !cleanCode || !normalizedPhone) return fail(res, 400, 'Facility name, unique code, and a valid Nigerian duty phone are required.');
  try {
    const data = must(await supabase.from('facilities').insert({ name: cleanName, code: cleanCode, phone: normalizedPhone, address: cleanText(address, 250) || null, is_active: true }).select('*').single());
    res.status(201).json({ success: true, facility: data });
  } catch (error) {
    if (error.code === '23505') return fail(res, 409, 'That facility code is already used.');
    throw error;
  }
}));

/* ------------------------------------------------------------------ */
/* Placing calls (manual button and the scheduled dispatcher)           */
/* ------------------------------------------------------------------ */
async function loadCallContext(callId) {
  const call = must(await supabase.from('calls').select('*').eq('id', callId).maybeSingle());
  if (!call) return null;
  const appointment = must(await supabase.from('appointment').select('id,child_id').eq('id', call.appointment_id).maybeSingle());
  const child = appointment ? must(await supabase.from('children').select('id,caregiver_id,facility_id').eq('id', appointment.child_id).maybeSingle()) : null;
  const caregiver = child ? must(await supabase.from('caregivers').select('id,facility_id,phone,preferred_language,consent_given,consent_withdrawn_at').eq('id', child.caregiver_id).maybeSingle()) : null;
  return { call, appointment, child, caregiver };
}
async function countAttempts(callId) {
  const { count, error } = await supabase.from('call_attempts').select('id', { count: 'exact', head: true }).eq('call_id', callId);
  if (error) throw error;
  return count || 0;
}

// After a call that was not answered (or was answered with no keypress): retry later if allowed, else close it.
async function finalizeUnanswered(callId, outcome) {
  const call = must(await supabase.from('calls').select('id,status').eq('id', callId).maybeSingle());
  if (!call || call.status !== 'in_progress') return 'ignored';
  const attempts = await countAttempts(callId);
  let retry = attempts < MAX_ATTEMPTS && ['no_answer', 'busy', 'failed', 'no_response'].includes(outcome);
  if (retry) {
    const ctx = await loadCallContext(callId);
    retry = Boolean(ctx && ctx.caregiver && ctx.caregiver.phone && consentActive(ctx.caregiver));
  }
  if (retry) {
    const next = scheduledAt(new Date(Date.now() + RETRY_DELAY_MINUTES * 60000).toISOString(), 0);
    must(await supabase.from('calls').update({ status: 'scheduled', scheduled_at: next, completed_at: null }).eq('id', callId).eq('status', 'in_progress'));
    return 'rescheduled';
  }
  const status = outcome === 'failed' || outcome === 'canceled' ? 'failed' : 'no_answer';
  must(await supabase.from('calls').update({ status, completed_at: new Date().toISOString() }).eq('id', callId).eq('status', 'in_progress'));
  const ctx = await loadCallContext(callId);
  if (ctx && ctx.child) await maybeDeleteCaregiverPhone(ctx.child.caregiver_id);
  return status;
}

const languageForCall = (call, caregiver) => {
  const code = call.language_code || caregiver.preferred_language || 'ha';
  return code === 'en' ? 'en' : 'ha'; // Kanuri callers hear Hausa until a Kanuri recording exists
};

async function startCall(callId, { manual, actor }) {
  const ctx = await loadCallContext(callId);
  if (!ctx || !ctx.caregiver || (actor && !hasFacility(actor, ctx.caregiver.facility_id))) return { ok: false, status: 404, reason: 'Scheduled call not found.' };
  const { call, caregiver } = ctx;
  if (call.status !== 'scheduled' || !call.follow_up_hours) return { ok: false, status: 409, reason: 'This call is not scheduled.' };
  if (!caregiver.phone || !consentActive(caregiver)) {
    if (!manual) must(await supabase.from('calls').update({ status: 'cancelled', completed_at: new Date().toISOString() }).eq('id', call.id).eq('status', 'scheduled'));
    return { ok: false, status: 409, reason: 'No call can be made without a current phone number and consent.', cancelled: !manual };
  }
  if (!call.scheduled_at || new Date(call.scheduled_at) > new Date()) return { ok: false, status: 409, reason: 'This call is not due yet.' };
  if (!withinCallWindow()) return { ok: false, status: 409, reason: 'Calls are only placed between 07:00 and 20:00 Lagos time.', deferred: true };
  const attempts = await countAttempts(call.id);
  if (attempts >= MAX_ATTEMPTS) return { ok: false, status: 409, reason: 'The maximum number of call attempts has been reached.' };

  // Claim the call first so two requests can never dial the same call.
  const claimed = must(await supabase.from('calls').update({ status: 'in_progress' }).eq('id', call.id).eq('status', 'scheduled').select('id').maybeSingle());
  if (!claimed) return { ok: false, status: 409, reason: 'This call is already being handled.' };
  let attempt;
  try {
    attempt = must(await supabase.from('call_attempts').insert({ call_id: call.id, attempt_number: attempts + 1, status: 'initiated' }).select('id').single());
  } catch (error) {
    await supabase.from('calls').update({ status: 'scheduled' }).eq('id', call.id).eq('status', 'in_progress');
    throw error;
  }
  const language = languageForCall(call, caregiver);
  const q = new URLSearchParams({ callId: call.id, attemptId: attempt.id, language, hours: String(call.follow_up_hours) });
  let dialed;
  try {
    dialed = await twilioClient.calls.create({
      to: caregiver.phone, from: env.TWILIO_PHONE_NUMBER, url: `${PUBLIC_BASE_URL}/twilio/voice?${q}`, method: 'POST',
      statusCallback: `${PUBLIC_BASE_URL}/twilio/status?${new URLSearchParams({ callId: call.id, attemptId: attempt.id })}`,
      statusCallbackMethod: 'POST', statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });
  } catch (dialError) {
    logError('twilio-dial', dialError);
    try {
      await supabase.from('call_attempts').update({ status: 'completed', outcome: 'failed', provider_status: 'failed', ended_at: new Date().toISOString() }).eq('id', attempt.id);
      await finalizeUnanswered(call.id, 'failed');
    } catch (e) { logError('twilio-dial-cleanup', e); }
    return { ok: false, status: 502, reason: 'Twilio could not start the call.' };
  }
  const { error: sidError } = await supabase.from('call_attempts').update({ twilio_call_sid: dialed.sid, provider_status: dialed.status }).eq('id', attempt.id);
  if (sidError) logError('attempt-sid', sidError);
  return { ok: true, callSid: dialed.sid, attemptId: attempt.id };
}

app.post('/api/calls/:id/initiate', requireAuth, staff(...STAFF_ROLES), route(async (req, res) => {
  if (!callingReady()) return fail(res, 503, 'Outbound calls are paused until Twilio credit and approved complete recordings are ready.');
  if (!isUuid(req.params.id)) return fail(res, 404, 'Scheduled call not found.');
  const result = await startCall(req.params.id, { manual: true, actor: req.profile });
  if (!result.ok) return fail(res, result.status, result.reason);
  res.json({ success: true, callSid: result.callSid, attemptId: result.attemptId });
}));

/* ------------------------------------------------------------------ */
/* Twilio webhooks (every request is signature-checked)                 */
/* ------------------------------------------------------------------ */
function verifyTwilio(req, res, next) {
  if (!twilioConfigured) return fail(res, 503, 'Twilio is not configured.');
  const signature = req.get('x-twilio-signature') || '';
  let valid = false;
  try { valid = twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, PUBLIC_BASE_URL + req.originalUrl, req.body || {}); } catch (_e) { valid = false; }
  if (!valid) { console.warn('[twilio] rejected a request with an invalid signature:', req.path); return fail(res, 403, 'Invalid Twilio signature.'); }
  next();
}
const sendTwiml = (res, vr) => res.type('text/xml').send(vr.toString());
// Plain US English is used for the few spoken confirmations because it is always supported by Twilio.
const goodbye = text => { const vr = new twilio.twiml.VoiceResponse(); if (text) vr.say({ language: 'en-US' }, text); vr.hangup(); return vr; };
function parseCallQuery(query) {
  const hours = Number(query.hours);
  if (!isUuid(query.callId) || !isUuid(query.attemptId) || ![24, 72].includes(hours)) return null;
  const language = query.language === 'en' ? 'en' : query.language === 'ha' ? 'ha' : null;
  return { callId: query.callId, attemptId: query.attemptId, hours, language, r: Math.min(Number(query.r) || 0, 3) };
}
const audioUrl = q => `${PUBLIC_BASE_URL}/audio/call${q.hours === 72 ? 2 : 1}_${q.language}.mp3`;
const keyAction = q => `${PUBLIC_BASE_URL}/twilio/key?${new URLSearchParams({ callId: q.callId, attemptId: q.attemptId, language: q.language, hours: String(q.hours), r: String(q.r || 0) })}`;
// The recording plays inside <Gather>, so the caregiver can press a key at any moment.
function promptWithKeys(vr, q) {
  const gather = vr.gather({ numDigits: 1, timeout: 8, actionOnEmptyResult: true, method: 'POST', action: keyAction(q) });
  gather.play(audioUrl(q));
}

app.post('/twilio/voice', verifyTwilio, route(async (req, res) => {
  const q = parseCallQuery(req.query);
  if (!q || !q.language) return sendTwiml(res, goodbye('We could not start this call. Goodbye.'));
  try {
    const attempt = must(await supabase.from('call_attempts').select('id').eq('id', q.attemptId).eq('call_id', q.callId).maybeSingle());
    if (!attempt) return sendTwiml(res, goodbye('We could not start this call. Goodbye.'));
  } catch (error) { logError('twilio-voice', error); return sendTwiml(res, goodbye('We could not start this call. Goodbye.')); }
  const vr = new twilio.twiml.VoiceResponse();
  promptWithKeys(vr, q);
  sendTwiml(res, vr);
}));

// Worried callers always create a callback task BEFORE the call is marked answered.
async function ensureWorriedCallback(callId, hours) {
  const ctx = await loadCallContext(callId);
  if (!ctx || !ctx.caregiver || !ctx.child) throw new Error('Call context not found for callback creation.');
  const existing = must(await supabase.from('callbacks').select('id').eq('call_id', callId).limit(1));
  if (existing.length) return existing[0].id;
  const { data, error } = await supabase.from('callbacks').insert({
    facility_id: ctx.caregiver.facility_id, caregiver_id: ctx.caregiver.id, child_id: ctx.child.id, call_id: callId,
    source: hours === 72 ? 'worried_72h' : 'worried_24h', priority: 'urgent', status: 'open', reason: 'Caregiver pressed 1 (worried)'
  }).select('id').single();
  if (error && error.code !== '23505') throw error;
  return data ? data.id : null;
}

app.post('/twilio/key', verifyTwilio, route(async (req, res) => {
  const q = parseCallQuery(req.query);
  if (!q || !q.language) return sendTwiml(res, goodbye('We could not continue this call. Goodbye.'));
  const digit = String((req.body && req.body.Digits) || '').trim();
  let where = 'start';
  try {
    where = 'load';
    const attempt = must(await supabase.from('call_attempts').select('id,status,keypad_sequence').eq('id', q.attemptId).eq('call_id', q.callId).maybeSingle());
    const call = must(await supabase.from('calls').select('id,status').eq('id', q.callId).maybeSingle());
    if (!attempt || !call) return sendTwiml(res, goodbye('We could not find this call. Please contact your health facility.'));
    if (attempt.status === 'completed') return sendTwiml(res, goodbye('Thank you. Goodbye.'));

    const validDigit = /^[1-4]$/.test(digit);
    if (validDigit) {
      where = 'sequence';
      const { error } = await supabase.from('call_attempts').update({ keypad_sequence: [...(attempt.keypad_sequence || []), Number(digit)] }).eq('id', attempt.id);
      if (error) logError('twilio-sequence', error);
    }
    if (digit === '3') { const vr = new twilio.twiml.VoiceResponse(); promptWithKeys(vr, { ...q, r: 0 }); return sendTwiml(res, vr); }
    if (digit === '4') {
      const vr = new twilio.twiml.VoiceResponse();
      const gather = vr.gather({ numDigits: 1, timeout: 8, actionOnEmptyResult: true, method: 'POST',
        action: `${PUBLIC_BASE_URL}/twilio/language?${new URLSearchParams({ callId: q.callId, attemptId: q.attemptId, hours: String(q.hours), language: q.language })}` });
      gather.say({ language: 'en-US' }, 'For Hausa press 1. For English press 2.');
      return sendTwiml(res, vr);
    }
    if (digit === '1' || digit === '2') {
      const worried = digit === '1';
      where = 'callback';
      if (worried) await ensureWorriedCallback(q.callId, q.hours);
      where = 'finalize';
      const now = new Date().toISOString();
      must(await supabase.from('call_attempts').update({ response: worried ? 'worried' : 'well', outcome: 'answered', status: 'completed', ended_at: now }).eq('id', attempt.id));
      must(await supabase.from('calls').update({ status: worried ? 'answered_worried' : 'answered_well', completed_at: now }).eq('id', q.callId));
      const ctx = await loadCallContext(q.callId);
      if (ctx && ctx.child) await maybeDeleteCaregiverPhone(ctx.child.caregiver_id);
      return sendTwiml(res, goodbye(worried ? 'A health worker will call you.' : 'Thank you. Goodbye.'));
    }
    // No key, or a key that means nothing: play once more, then record "no response".
    if (q.r < 1) { const vr = new twilio.twiml.VoiceResponse(); promptWithKeys(vr, { ...q, r: q.r + 1 }); return sendTwiml(res, vr); }
    where = 'no-response';
    must(await supabase.from('call_attempts').update({ response: null, outcome: 'no_response', status: 'completed', ended_at: new Date().toISOString() }).eq('id', attempt.id));
    await finalizeUnanswered(q.callId, 'no_response');
    return sendTwiml(res, goodbye('We did not receive a response. Goodbye.'));
  } catch (error) {
    logError('twilio-key', error, { where });
    return sendTwiml(res, goodbye('We could not record your response. Please contact your health facility.'));
  }
}));

app.post('/twilio/language', verifyTwilio, route(async (req, res) => {
  const q = parseCallQuery(req.query);
  if (!q || !q.language) return sendTwiml(res, goodbye('We could not continue this call. Goodbye.'));
  const digit = String((req.body && req.body.Digits) || '').trim();
  const language = digit === '1' ? 'ha' : digit === '2' ? 'en' : q.language;
  try {
    const attempt = must(await supabase.from('call_attempts').select('id,status,keypad_sequence').eq('id', q.attemptId).eq('call_id', q.callId).maybeSingle());
    if (!attempt || attempt.status === 'completed') return sendTwiml(res, goodbye('Thank you. Goodbye.'));
    if (/^[12]$/.test(digit)) must(await supabase.from('call_attempts').update({ keypad_sequence: [...(attempt.keypad_sequence || []), Number(digit)] }).eq('id', attempt.id));
    must(await supabase.from('calls').update({ language_code: language }).eq('id', q.callId));
    const vr = new twilio.twiml.VoiceResponse();
    promptWithKeys(vr, { ...q, language, r: 0 });
    sendTwiml(res, vr);
  } catch (error) {
    logError('twilio-language', error);
    sendTwiml(res, goodbye('We could not continue this call. Please contact your health facility.'));
  }
}));

app.post('/twilio/status', verifyTwilio, async (req, res) => {
  try {
    const { callId, attemptId } = req.query;
    if (!isUuid(callId) || !isUuid(attemptId)) return res.sendStatus(204);
    const state = String((req.body && req.body.CallStatus) || '');
    const sid = String((req.body && req.body.CallSid) || '');
    const duration = Number.parseInt(req.body && req.body.CallDuration, 10);
    const terminal = ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(state);
    const outcome = { completed: 'answered', busy: 'busy', 'no-answer': 'no_answer', failed: 'failed', canceled: 'canceled' }[state];
    const attempt = must(await supabase.from('call_attempts').select('id,status,response').eq('id', attemptId).eq('call_id', callId).maybeSingle());
    if (!attempt) return res.sendStatus(204);
    const update = { provider_status: state || null };
    if (sid) update.twilio_call_sid = sid;
    if (terminal) {
      update.duration_seconds = Number.isFinite(duration) ? duration : null;
      if (attempt.status !== 'completed') Object.assign(update, { status: 'completed', ended_at: new Date().toISOString(), outcome: state === 'completed' ? 'no_response' : outcome });
    }
    must(await supabase.from('call_attempts').update(update).eq('id', attempt.id));
    // A terminal status with no recorded keypad response means the call is still open: close or retry it.
    if (terminal && attempt.status !== 'completed' && !attempt.response) {
      await finalizeUnanswered(callId, state === 'completed' ? 'no_response' : outcome);
    }
    res.sendStatus(204);
  } catch (error) { logError('twilio-status', error); res.sendStatus(204); }
});

/* ------------------------------------------------------------------ */
/* Recorded audio (served to Twilio from the GitHub Pages recordings)   */
/* ------------------------------------------------------------------ */
const audioCache = new Map();
app.get('/audio/:filename', async (req, res) => {
  const filename = req.params.filename;
  if (!/^call[12]_(?:en|ha)\.mp3$/.test(filename)) return res.sendStatus(404);
  try {
    let entry = audioCache.get(filename);
    if (!entry || entry.until < Date.now()) {
      const upstream = await fetch(`${AUDIO_BASE_URL}/${filename}`, { signal: AbortSignal.timeout(15000) });
      if (!upstream.ok) return res.status(502).send('Audio unavailable.');
      const audio = Buffer.from(await upstream.arrayBuffer());
      if (!audio.length) return res.status(502).send('Audio unavailable.');
      entry = { audio, until: Date.now() + 10 * 60000 };
      audioCache.set(filename, entry);
    }
    res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': String(entry.audio.length), 'Cache-Control': 'public, max-age=3600' }).send(entry.audio);
  } catch (error) { logError('audio-proxy', error); res.status(502).send('Audio unavailable.'); }
});

/* ------------------------------------------------------------------ */
/* Scheduled work: due calls, stuck attempts, retention                 */
/* ------------------------------------------------------------------ */
async function reapStuckAttempts() {
  const cutoff = new Date(Date.now() - 45 * 60000).toISOString();
  const stuck = must(await supabase.from('call_attempts').select('id,call_id').eq('status', 'initiated').lte('started_at', cutoff).limit(20));
  for (const a of stuck) {
    const { error } = await supabase.from('call_attempts').update({ status: 'completed', outcome: 'no_response', ended_at: new Date().toISOString() }).eq('id', a.id).eq('status', 'initiated');
    if (error) { logError('reap-attempt', error); continue; }
    try { await finalizeUnanswered(a.call_id, 'no_response'); } catch (e) { logError('reap-finalize', e); }
  }
  return stuck.length;
}

let dispatchBusy = false;
async function dispatchDueCalls() {
  const summary = { dialed: 0, skipped: 0, cancelled: 0, failed: 0, reaped: 0 };
  if (!callingReady()) return { ...summary, paused: true };
  if (dispatchBusy) return { ...summary, busy: true };
  dispatchBusy = true;
  try {
    summary.reaped = await reapStuckAttempts();
    const due = must(await supabase.from('calls').select('id').eq('status', 'scheduled').not('follow_up_hours', 'is', null)
      .lte('scheduled_at', new Date().toISOString()).order('scheduled_at').limit(10));
    for (const row of due) {
      try {
        const result = await startCall(row.id, { manual: false });
        if (result.ok) summary.dialed += 1;
        else if (result.cancelled) summary.cancelled += 1;
        else if (result.deferred) { summary.skipped += 1; break; } // outside the calling window: nothing else is due either
        else if (result.status === 502) summary.failed += 1;
        else summary.skipped += 1;
        if (result.ok) await sleep(250);
      } catch (error) { summary.failed += 1; logError('dispatch-call', error); }
    }
  } catch (error) { logError('dispatch', error); }
  finally { dispatchBusy = false; }
  return summary;
}
if (CALLS_ENABLED) setInterval(() => { dispatchDueCalls().catch(e => logError('dispatch', e)); }, 60000).unref();

// Optional: lets an external scheduler (or uptime monitor with custom headers) trigger a dispatch.
app.post('/internal/dispatch', route(async (req, res) => {
  if (!CRON_SECRET) return fail(res, 404, 'Route not found.');
  const given = Buffer.from(String(req.get('x-cron-secret') || '')), wanted = Buffer.from(CRON_SECRET);
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return fail(res, 403, 'Forbidden.');
  res.json({ ok: true, ...(await dispatchDueCalls()) });
}));

// Only closed records whose retention date has passed are removed, and only if nothing else still points at them.
async function retentionCleanup() {
  const now = new Date().toISOString();
  const removed = { callbacks: 0, attempts: 0, calls: 0 };
  const closedCallbacks = must(await supabase.from('callbacks').select('id').in('status', ['completed', 'cancelled']).not('retention_expires_at', 'is', null).lte('retention_expires_at', now).limit(500));
  if (closedCallbacks.length) { must(await supabase.from('callbacks').delete().in('id', closedCallbacks.map(x => x.id))); removed.callbacks = closedCallbacks.length; }
  const oldAttempts = must(await supabase.from('call_attempts').select('id').eq('status', 'completed').not('retention_expires_at', 'is', null).lte('retention_expires_at', now).limit(500));
  if (oldAttempts.length) { must(await supabase.from('call_attempts').delete().in('id', oldAttempts.map(x => x.id))); removed.attempts = oldAttempts.length; }
  const oldCalls = must(await supabase.from('calls').select('id').in('status', ['answered_well', 'answered_worried', 'no_answer', 'failed', 'cancelled']).not('retention_expires_at', 'is', null).lte('retention_expires_at', now).limit(200));
  for (const call of oldCalls) {
    const { count: attemptCount } = await supabase.from('call_attempts').select('id', { count: 'exact', head: true }).eq('call_id', call.id);
    const { count: callbackCount } = await supabase.from('callbacks').select('id', { count: 'exact', head: true }).eq('call_id', call.id);
    if (attemptCount === 0 && callbackCount === 0) { const { error } = await supabase.from('calls').delete().eq('id', call.id); if (!error) removed.calls += 1; }
  }
  if (removed.callbacks || removed.attempts || removed.calls) console.log('[retention] removed', JSON.stringify(removed));
}
setInterval(() => retentionCleanup().catch(error => logError('retention', error)), 6 * 60 * 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* Errors                                                               */
/* ------------------------------------------------------------------ */
app.use((_req, res) => fail(res, 404, 'Route not found.'));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof HttpError) return fail(res, error.status, error.message, error.extra);
  if (error && error.type === 'entity.parse.failed') return fail(res, 400, 'The request body is not valid JSON.');
  if (error && error.type === 'entity.too.large') return fail(res, 413, 'The request is too large.');
  const mapped = mapDbError(error);
  logError(`${req.method} ${req.path}`, error, { mapped: Boolean(mapped) });
  if (mapped) return fail(res, mapped.status, mapped.message);
  fail(res, 500, 'The request could not be completed.');
});

process.on('unhandledRejection', reason => logError('unhandledRejection', reason instanceof Error ? reason : { message: String(reason) }));

// Binding to 0.0.0.0 lets Render detect the open port.
app.listen(PORT, '0.0.0.0', () => console.log(`Lafiya Line API running on ${PORT}; outbound calls ${callingReady() ? 'enabled' : 'paused'}.`));
