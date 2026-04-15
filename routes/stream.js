const express = require('express');
const ingestion = require('../services/ingestion');

const router = express.Router();

router.get('/', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  res.write('data: {"type":"connected"}\n\n');

  const clients = ingestion.getSseClients();
  clients.push(res);
  ingestion.setSseClients(clients);

  req.on('close', () => {
    const current = ingestion.getSseClients();
    ingestion.setSseClients(current.filter(c => c !== res));
  });
});

module.exports = router;
