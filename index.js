const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { DeepgramClient } = require('@deepgram/sdk');

const app = express();
const server = http.createServer(app);

const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });

app.get('/', (req, res) => {
  res.send('v2-human-detector alive');
});

const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', async (ws) => {
  console.log('🔌 Twilio Media Stream conectado');

  let callSid = null;
  let chunkCount = 0;
  let dg = null;
  let dgReady = false;

  try {
    dg = await deepgram.listen.v1.connect({
      model: 'nova-3',
      language: 'en-US',
      encoding: 'mulaw',
      sample_rate: 8000,
      channels: 1,
      punctuate: true,
      interim_results: true,
    });

    dg.on('message', (data) => {
      console.log('🔎 DG msg type:', data.type);
      if (data.type === 'Results') {
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (transcript && transcript.trim()) {
          const tipo = data.is_final ? 'FINAL' : 'parcial';
          console.log(`📝 [${tipo}] ${transcript}`);
        }
      }
    });

    dg.on('error', (err) => {
      console.error('❌ error Deepgram:', err);
    });

    dg.on('close', () => {
      console.log('🎙️  Deepgram cerrado');
      dgReady = false;
    });

    dg.connect();
    await dg.waitForOpen();
    dgReady = true;
    console.log('🎙️  Deepgram conectado y listo');
    console.log('🔧 métodos:', Object.getOwnPropertyNames(Object.getPrototypeOf(dg)).join(', '));
  } catch (e) {
    console.error('❌ no se pudo conectar Deepgram:', e.message);
  }

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    switch (msg.event) {
      case 'connected':
        console.log('✅ evento: connected');
        break;

      case 'start':
        callSid = msg.start.callSid;
        console.log('▶️  start | callSid:', callSid);
        break;

      case 'media':
        chunkCount++;
        if (dgReady && dg) {
          try {
            const audio = Buffer.from(msg.media.payload, 'base64');
            if (chunkCount === 1) {
              console.log('🔊 primer chunk, bytes:', audio.length);
            }
            dg.sendMedia(audio);
          } catch (e) {
            console.error('error enviando audio:', e.message);
          }
        }
        break;

      case 'stop':
        console.log('⏹️  stop | chunks:', chunkCount);
        if (dg) { try { dg.close(); } catch (e) {} }
        break;
    }
  });

  ws.on('close', () => {
    console.log('🔌 Media Stream desconectado | chunks:', chunkCount);
    if (dg) { try { dg.close(); } catch (e) {} }
  });

  ws.on('error', (err) => {
    console.error('❌ error WebSocket:', err.message);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 servidor escuchando en puerto ${PORT}`);
});
