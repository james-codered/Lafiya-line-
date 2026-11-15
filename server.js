const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Environment configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const PORT = process.env.PORT || 3000;

// Validate required environment variables
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error('Missing Supabase environment variables.');
    process.exit(1);
}

// Initialize Supabase
const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_SECRET_KEY
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
            console.error('Supabase connection check failed:', error.message);

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

// Twilio voice endpoint
app.post('/voice', (req, res) => {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say language="en-US">
        Hello, this is Lafiya Line. We are calling to check on you and your baby after immunisation. Is your baby feeding normally?
    </Say>
</Response>`;

    res.status(200);
    res.type('text/xml');
    res.send(twiml);
});

// Handle unknown routes
app.use((req, res) => {
    res.status(404).json({
        error: 'Route not found'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Lafiya Line server running on port ${PORT}`);
});
