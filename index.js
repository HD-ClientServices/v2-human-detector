const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { DeepgramClient } = require('@deepgram/sdk');

const app = express();
const server = http.createServer(app);

const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });

// ============================================================
//  DETECTOR DE SALUDO HUMANO
//  Patrones extraídos de grabaciones reales:
//   Century      -> "Mel here with Century, on a recorded line"
//   First Choice -> "This is John on a recorded line"
//   Quantum      -> "Hey Heather, good morning, how are you doing?"
// ============================================================
const MARCADORES = {
  identificacion: [
    /\bthis is \w+/i,
    /\b\w+ here with\b/i,
    /\brecorded line\b/i,
    /\brecording\b/i,
    /\bmy name is\b/i,
    /\bspeaking with\b/i,
  ],
  saludo: [
    /\bhow are you\b/i,
    /\bgood morning\b/i,
    /\bgood afternoon\b/i,
    /\bgood evening\b/i,
    /\bhow's it going\b/i,
    /\bhow can i help\b/i,
  ],
  verificacion: [
    /\bis this \w+/i,
    /\bam i speaking\b/i,
  ],
};

const BUYERS = [/\bcentury\b/i, /\bfirst choice\b/i, /\bquantum\b/i];

function detectarHumano(texto) {
  const hits = [];

  for (const [familia, patrones] of Object.entries(MARCADORES)) {
    for (const p of patrones) {
      if (p.test(texto)) {
        hits.push(familia);
        break;
      }
    }
  }

  for (const b of BUYERS) {
    if (b.test(texto)) {
      hits.push('buyer_name');
      break;
    }
  }

  return hits;
}

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
  let humanoDetectado = false;
  const inicioLlamada = Date.now();

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
      if (data.type === 'Results') {
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (transcript && transcript.trim()) {
          const tipo = data.is_final ? 'FINAL' : 'parcial';
          console.log(`📝 [${tipo}] ${transcript}`);

          if (!humanoDetectado) {
            const hits = detectarHumano(transcript);
            if (hits.length > 0) {
              humanoDetectado = true;
              const ms = Date.now() - inicioLlamada;
              console.log('');
              console.log('🚨🚨🚨 HUMANO DETECTADO 🚨🚨🚨');
              console.log(`    a los ${(ms / 1000).toFixed(1)}s de iniciada la llamada`);
              console.log(`    frase: "${transcript}"`);
              console.log(`    señales: ${hits.join(', ')}`);
              console.log('');
            }
          }
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
        console.log('⏹️  stop | chunks:', chunkCount, '| humano detectado:', humanoDetectado);
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
