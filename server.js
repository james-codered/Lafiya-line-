const express = require('express');
const app = express();

const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-US">
    Hello, this is Lafiya Line.
    We are calling to check on you and your baby after immunisation.
    Is your baby feeding normally?
  </Say>
</Response>`;

app.all('/voice', (req, res) => {
  res.type('text/xml').send(twiml);
});

app.get('/', (req, res) => {
  res.send('Lafiya Line Voice Server is running!');
});

app.listen(process.env.PORT || 3000);
