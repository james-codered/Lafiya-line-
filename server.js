// Serve recordings
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Allow requests from the Lafiya Line frontend
app.use((req, res, next) => {
    res.header(
        'Access-Control-Allow-Origin',
        'https://elijahamosdogo-afk.github.io'
    );
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
});

// Environment configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const PORT = process.env.PORT || 3000;

const BASE_URL = 'https://lafiya-line-voice.onrender.com';

const AUDIO_BASE_URL =
    'https://elijahamosdogo-afk.github.io/Lafiya-line-/audio';

// Validate required environment variables
if (
    !SUPABASE_URL ||
    !SUPABASE_SECRET_KEY ||
    !TWILIO_ACCOUNT_SID ||
    !TWILIO_AUTH_TOKEN ||
    !TWILIO_PHONE_NUMBER
) {
    console.error('Missing required environment variables.');
    process.exit(1);
}

// Initialize Supabase
const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_SECRET_KEY
);

// Initialize Twilio
const client = twilio(
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN
);

// Root endpoint
app.get('/', (req, res) => {
    res.status(200).send('Lafiya Line Voice Server is running!');
});

// Database connection check
app.get('/db-check', async (req, res) => {
    try {
        const { error } = await supabase
            .from('facilities')
            .select('id')
            .limit(1);

        if (error) {
            console.error(
                'Supabase connection check failed:',
                error.message
            );

            return res.status(503).json({
                connected: false,
                error: 'Database check failed'
            });
        }

        return res.status(200).json({
            connected: true,
            message: 'Supabase database is responding'
        });

    } catch (error) {
        console.error('Database error:', error.message);

        return res.status(500).json({
            connected: false,
            error: 'Internal server error'
        });
    }
});

// Initiate an outbound phone call
app.post('/make-call', async (req, res) => {
    try {
        const { to, language, callType } = req.body;

        if (!to || !language || !callType) {
            return res.status(400).json({
                error: 'Phone number, language and call type are required.'
            });
        }

        // Validate phone number format
        if (!/^\+[1-9]\d{7,14}$/.test(to)) {
            return res.status(400).json({
                error: 'Phone number must use international format, e.g. +234...'
            });
        }

        // Select supported language
        const lang = language === 'English' ? 'en' : 'ha';

        if (!['English', 'Hausa', 'Kanuri'].includes(language)) {
            return res.status(400).json({
                error: 'Unsupported language.'
            });
        }

        // Validate reminder type
        if (![1, 2].includes(Number(callType))) {
            return res.status(400).json({
                error: 'Call type must be 1 or 2.'
            });
        }

        // Pass call details to Twilio's voice webhook
        const voiceUrl = new URL(`${BASE_URL}/voice`);

        voiceUrl.searchParams.set('language', lang);
        voiceUrl.searchParams.set('callType', Number(callType));

        const call = await client.calls.create({
            to,
            from: TWILIO_PHONE_NUMBER,
            url: voiceUrl.toString(),
            method: 'POST'
        });

        return res.status(200).json({
            success: true,
            message: 'Call initiated successfully.',
            callSid: call.sid,
            status: call.status
        });

    } catch (error) {
        console.error('Twilio call error:', error);
        return res.status(500).json({
            success: false,
            error: 'Unable to initiate phone call.'
        });
    }
});

// Serve recordings through Render with the MIME type Twilio expects for MP3.
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
            console.error('Audio upstream returned HTTP ' + upstream.status);
            return res.status(502).send('Audio unavailable.');
        }

        const audio = Buffer.from(await upstream.arrayBuffer());
        if (audio.length === 0) {
            return res.status(502).send('Audio unavailable.');
        }

        res.set('Content-Type', 'audio/mpeg');
        res.set('Content-Length', String(audio.length));
        res.set('Cache-Control', 'public, max-age=3600');
        return res.status(200).send(audio);
    } catch (error) {
        console.error('Audio proxy error:', error.message);
        return res.status(502).send('Audio unavailable.');
    }
});

// Twilio voice webhook: play the correct recording
app.post('/voice', (req, res) => {
    const language = req.query.language;
    const callType = Number(req.query.callType);

    const lang = language === 'en' ? 'en' : 'ha';

    if (!['en', 'ha'].includes(language) ||
        ![1, 2].includes(callType)) {
        return res.status(400).send('Invalid voice settings.');
    }

    const recording =
        `call${callType}_${lang}.mp3`;

    const twiml = new twilio.twiml.VoiceResponse();

    twiml.play(BASE_URL + '/audio/' + recording);

    res.type('text/xml');
    res.status(200).send(twiml.toString());
});

// Handle unknown routes
app.use((req, res) => {
    res.status(404).json({
        error: 'Route not found'
    });
});

// Start server
// LAFIYA LINE: SAVE REGISTRATION TO SUPABASE

const DEMO_FACILITY_ID = '1a6ecdd8-de26-44f0-8ffa-3b240485003f';

app.post('/register', async (req, res) => {
    try {
        const {
            phone,
            language,
            referredBy,
            age,
            ageUnit,
            dose,
            nextDoseDate
        } = req.body;

        // Validate required information
        if (
            !phone ||
            !language ||
            !age ||
            !dose ||
            !nextDoseDate
        ) {
            return res.status(400).json({
                success: false,
                message: 'Missing registration information'
            });
        }

        const cleanPhone = phone.replace(/\s/g, '');

        if (!/^(0|\+234)[789]\d{9}$/.test(cleanPhone)) {
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

        if (
            !Number.isFinite(numericAge) ||
            numericAge < 0 ||
            numericAge > (ageUnit === 'weeks' ? 104 : 59)
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid child age'
            });
        }

        // Calculate date of birth
        const days = Math.round(
            numericAge * (ageUnit === 'weeks' ? 7 : 30.4)
        );

        const dob = new Date();
        dob.setDate(dob.getDate() - days);

        const dateOfBirth = dob.toISOString().slice(0, 10);

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
                .select()
                .single();

        if (caregiverError) throw caregiverError;

        // Generate child reference
        const childReference =
            'Baby LL-' + Date.now().toString().slice(-6);

        // Save child
        const { data: child, error: childError } =
            await supabase
                .from('children')
                .insert({
                    caregiver_id: caregiver.id,
                    child_name: childReference,
                    date_of_birth: dateOfBirth,
                    facility_id: DEMO_FACILITY_ID
                })
                .select()
                .single();

        if (childError) {
            await supabase
                .from('caregivers')
                .delete()
                .eq('id', caregiver.id);

            throw childError;
        }

        // Save dose given today
        const { error: firstAppointmentError } =
            await supabase
                .from('appointment')
                .insert({
                    child_id: child.id,
                    vaccine: dose + ' dose',
                    dose_number: 1,
                    appointment_date:
                        new Date().toISOString().slice(0, 10),
                    status: 'attended',
                    returned: true
                });

        if (firstAppointmentError) throw firstAppointmentError;

        // Save next appointment
        const { error: nextAppointmentError } = 
            await supabase
                .from('appointment')
                .insert({
                    child_id: child.id,
                    vaccine: 'Next dose due',
                    dose_number: 2,
                    appointment_date: nextDoseDate,
                    status: 'scheduled',
                    returned: false
                });

        if (nextAppointmentError) throw nextAppointmentError;

        return res.status(201).json({
            success: true,
            message: 'Registration saved successfully',
            caregiver,
            child
        });

    } catch (error) {
        console.error('Registration error:', error);

        return res.status(500).json({
            success: false,
            message: 'Could not save registration',
            error: error.message
        });
    }
});
app.listen(PORT, () => {
    console.log(
        `Lafiya Line server running on port ${PORT}`
    );
});
