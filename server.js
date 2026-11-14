const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const supabase = createClient(
process.env.SUPABASE_URL,
process.env.SUPABASE_SECRET_KEY
);

const twiml = "<?xml version="1.0" encoding="UTF-8"?> <Response> <Say language="en-US"> Hello, this is Lafiya Line. We are calling to check on you and your baby after immunisation. Is your baby feeding normally? </Say> </Response>";

app.all('/voice', (req, res) => {
res.type('text/xml').send(twiml);
});

app.get('/db-check', async (req, res) => {
const { error } = await supabase
.from('facilities')
.select('id')
.limit(1);

if (error) {
return res.status(500).json({
connected: false,
error: error.message
});
}

res.json({ connected: true });
});

app.get('/', (req, res) => {
res.send('Lafiya Line Voice Server is running!');
});

app.listen(process.env.PORT || 3000);
