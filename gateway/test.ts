console.log('Starting...');

import express from 'express';

console.log('Express imported');

const app = express();

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(3001, () => {
  console.log('Listening on 3001');
});
