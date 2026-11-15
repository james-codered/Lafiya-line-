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
        console.error('Twilio call error:', error.message);

        return res.status(500).json({
            success: false,
            error: 'Unable to initiate phone call.'
        });
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

    twiml.play(
        `${AUDIO_BASE_URL}/${recording}`
    );

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
app.listen(PORT, () => {
    console.log(
        `Lafiya Line server running on port ${PORT}`
    );
});
