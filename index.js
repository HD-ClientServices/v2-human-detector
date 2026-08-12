const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);

// health check para Railway
app.get('/', (req, res) => {
  res.send('v2-human-detector alive');
});

// WebSocket server para recibir el audio de Twilio Media Streams
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws) => {
  console.log('🔌 Twilio Media Stream conectado');

  let messageCount = 0;
  let streamSid = null;

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    switch (msg.event) {
      case 'connected':
        console.log('✅ evento: connected', JSON.stringify(msg));
        break;

      case 'start':
        streamSid = msg.start.streamSid;
        console.log('▶️  evento: start | streamSid:', streamSid);
        console.log('    callSid:', msg.start.callSid);
        console.log('    tracks:', JSON.stringify(msg.start.tracks));
        break;

      case 'media':
        messageCount++;
        // el audio viene en msg.media.payload (base64, mulaw 8kHz)
        // logueamos cada 100 chunks para no saturar
        if (messageCount % 100 === 0) {
          console.log(`🎵 recibidos ${messageCount} chunks de audio | último ts: ${msg.media.timestamp}ms`);
        }
        break;

      case 'stop':
        console.log('⏹️  evento: stop | total chunks recibidos:', messageCount);
        break;

      default:
        console.log('❓ evento desconocido:', msg.event);
    }
  });

  ws.on('close', () => {
    console.log('🔌 Media Stream desconectado | total chunks:', messageCount);
  });

  ws.on('error', (err) => {
    console.error('❌ error en WebSocket:', err.message);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 servidor escuchando en puerto ${PORT}`);
  console.log(`   WebSocket path: /stream`);
});
