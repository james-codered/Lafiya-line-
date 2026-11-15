// Lafiya Line Backend
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// CORS
const ALLOWED_ORIGIN = 'https://elijahamosdogo-afk.github.io';

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
});

// Environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const PORT = process.env.PORT || 3000;

const BASE_URL = 'https://lafiya-line-voice.onrender.com';

const AUDIO_BASE_URL =
    'https://elijahamosdogo-afk.github.io/Lafiya-line-/audio';

const DEMO_FACILITY_ID =
    '1a6ecdd8-de26-44f0-8ffa-3b240485003f';

// Supabase is required
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error('Missing Supabase environment variables.');
    process.exit(1);
}

const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_SECRET_KEY
);

// Twilio is optional until configured
const twilioConfigured = Boolean(
    TWILIO_ACCOUNT_SID &&
    TWILIO_AUTH_TOKEN &&
    TWILIO_PHONE_NUMBER
);

const client = twilioConfigured
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// ROOT
app.get('/', (req, res) => {
    res.send('Lafiya Line Voice Server is running!');
});

// DATABASE CHECK
app.get('/db-check', async (req, res) => {
    try {
        const { error } = await supabase
            .from('facilities')
            .select('id')
            .limit(1);

        if (error) throw error;

        res.json({
            connected: true,
            message: 'Supabase database is responding'
        });

    } catch (error) {
        console.error('Database error:', error.message);

        res.status(503).json({
            connected: false,
            error: 'Database check failed'
        });
    }
});

// CAREGIVER REGISTRATION
app.post('/register', async (req, res) => {
    let caregiverId = null;
    let childId = null;

    try {
        const {
            phone,
            language,
            referredBy,
            age,
            ageUnit,
            dose,
            nextDoseDate
        } = req.body || {};

        // Validate required fields
        if (
            !phone ||
            !language ||
            age === undefined ||
            age === null ||
            age === '' ||
            !dose ||
            !nextDoseDate
        ) {
            return res.status(400).json({
                success: false,
                message: 'Missing registration information'
            });
        }

        if (typeof phone !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'Invalid phone number'
            });
        }

        const cleanPhone = phone.replace(/\s/g, '');

        if (!/^(0[789]\d{9}|\+234[789]\d{9})$/.test(cleanPhone)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid Nigerian phone number'
            });
        }

        if (!['Hausa', 'Kanuri', 'English'].includes(language)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid language'
            });
        }

        const numericAge = Number(age);
        const unit = ageUnit || 'months';

        if (
            !Number.isFinite(numericAge) ||
            numericAge < 0 ||
            !['weeks', 'months'].includes(unit) ||
            numericAge > (unit === 'weeks' ? 104 : 59)
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid child age'
            });
        }

        if (
            typeof nextDoseDate !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}$/.test(nextDoseDate) ||
            Number.isNaN(Date.parse(nextDoseDate + 'T00:00:00'))
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid next appointment date'
            });
        }

        // Calculate date of birth
        const days = Math.round(
            numericAge * (unit === 'weeks' ? 7 : 30.4)
        );

        const dob = new Date();
        dob.setDate(dob.getDate() - days);

        const dateOfBirth = dob.toISOString().slice(0, 10);
        const today = new Date().toISOString().slice(0, 10);

        // Save caregiver
        const { data: caregiver, error: caregiverError } =
            await supabase
                .from('caregivers')
                .insert({
                    name: 'Mother …' + cleanPhone.slice(-4),
                    phone: cleanPhone,
                    language,
                    facility_id: DEMO_FACILITY_ID,
                    consent: true,
                    referred_by: referredBy || null
                })
                .select('id')
                .single();

        if (caregiverError) throw caregiverError;

        caregiverId = caregiver.id;

        // Generate child reference
        const childReference =
            'Baby LL-' + Date.now().toString().slice(-6);

        // Save child
        const { data: child, error: childError } =
            await supabase
                .from('children')
                .insert({
                    caregiver_id: caregiverId,
                    child_name: childReference,
                    date_of_birth: dateOfBirth,
                    facility_id: DEMO_FACILITY_ID
                })
                .select('id, child_name')
                .single();

        if (childError) throw childError;

        childId = child.id;

        // Save appointments
        const { error: appointmentError } =
            await supabase
                .from('appointment')
                .insert([
                    {
                        child_id: childId,
                        vaccine: dose + ' dose',
                        dose_number: 1,
                        appointment_date: today,
                        status: 'attended',
                        returned: true
                    },
                    {
                        child_id: childId,
                        vaccine: 'Next dose due',
                        dose_number: 2,
                        appointment_date: nextDoseDate,
                        status: 'scheduled',
                        returned: false
                    }
                ]);

        if (appointmentError) throw appointmentError;

        console.log('Registration saved:', caregiverId, childId);

        return res.status(201).json({
            success: true,
            message: 'Registration saved successfully',
            caregiver: { id: caregiverId },
            child: {
                id: childId,
                child_name: child.child_name
            }
        });

    } catch (error) {
        console.error('Registration error:', {
            message: error.message,
            code: error.code,
            details: error.details
        });

        // Clean up incomplete registrations
        if (childId) {
            await supabase
                .from('children')
                .delete()
                .eq('id', childId);
        }

        if (caregiverId) {
            await supabase
                .from('caregivers')
                .delete()
                .eq('id', caregiverId);
        }

        return res.status(500).json({
            success: false,
            message: 'Could not save registration',
            error: error.message
        });
    }
});

// INITIATE PHONE CALL
app.post('/make-call', async (req, res) => {
    if (!twilioConfigured || !client) {
        return res.status(503).json({
            success: false,
            error: 'Phone calling is not configured yet.'
        });
    }

    try {
        const { to, language, callType } = req.body || {};

        if (!to || !language || !callType) {
            return res.status(400).json({
                error: 'Phone number, language and call type are required.'
            });
        }

        if (!/^\+[1-9]\d{7,14}$/.test(to)) {
            return res.status(400).json({
                error: 'Phone number must use international format.'
            });
        }

        if (!['English', 'Hausa', 'Kanuri'].includes(language)) {
            return res.status(400).json({
                error: 'Unsupported language.'
            });
        }

        if (![1, 2].includes(Number(callType))) {
            return res.status(400).json({
                error: 'Call type must be 1 or 2.'
            });
        }

        const lang = language === 'English' ? 'en' : 'ha';

        const voiceUrl = new URL(`${BASE_URL}/voice`);

        voiceUrl.searchParams.set('language', lang);
        voiceUrl.searchParams.set('callType', Number(callType));

        const call = await client.calls.create({
            to,
            from: TWILIO_PHONE_NUMBER,
            url: voiceUrl.toString(),
            method: 'POST'
        });

        res.json({
            success: true,
            message: 'Call initiated successfully.',
            callSid: call.sid,
            status: call.status
        });

    } catch (error) {
        console.error('Twilio error:', error.message);

        res.status(500).json({
            success: false,
            error: 'Unable to initiate phone call.'
        });
    }
});

// AUDIO PROXY
app.get('/audio/:filename', async (req, res) => {
    const filename = req.params.filename;

    if (!/^call[12]_(?:en|ha)\.mp3$/.test(filename)) {
        return res.sendStatus(404);
    }

    try {
        const upstream = await fetch(
            AUDIO_BASE_URL + '/' + filename,
            { signal: AbortSignal.timeout(15000) }
        );

        if (!upstream.ok) {
            return res.status(502).send('Audio unavailable.');
        }

        const audio = Buffer.from(await upstream.arrayBuffer());

        if (!audio.length) {
            return res.status(502).send('Audio unavailable.');
        }

        res.set('Content-Type', 'audio/mpeg');
        res.set('Content-Length', String(audio.length));
        res.set('Cache-Control', 'public, max-age=3600');

        return res.send(audio);

    } catch (error) {
        console.error('Audio proxy error:', error.message);
        res.status(502).send('Audio unavailable.');
    }
});

// TWILIO VOICE WEBHOOK
app.post('/voice', (req, res) => {
    const language = req.query.language;
    const callType = Number(req.query.callType);

    if (
        !['en', 'ha'].includes(language) ||
        ![1, 2].includes(callType)
    ) {
        return res.status(400).send('Invalid voice settings.');
    }

    const recording = `call${callType}_${language}.mp3`;

    const twiml = new twilio.twiml.VoiceResponse();

    twiml.play(BASE_URL + '/audio/' + recording);

    res.type('text/xml');
    res.send(twiml.toString());
});

// 404 HANDLER MUST BE LAST
app.use((req, res) => {
    res.status(404).json({
        error: 'Route not found'
    });
});

// START SERVER
app.listen(PORT, () => {
    console.log(`Lafiya Line server running on port ${PORT}`);
});
