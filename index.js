const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { DeepgramClient } = require('@deepgram/sdk');
const twilio = require('twilio');

const app = express();
const server = http.createServer(app);

const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ============================================================
//  DETECTOR DE SALUDO HUMANO
// ============================================================
const FUERTES = [
  { id: 'this_is_nombre',   re: /\bthis is [a-z]{2,}/i },
  { id: 'its_nombre',       re: /\bit'?s [a-z]{2,} (here|with|from|on)\b/i },
  { id: 'nombre_here_with', re: /\b[a-z]{2,} here with\b/i },
  { id: 'my_name_is',       re: /\bmy name is\b/i },
  { id: 'how_are_you',      re: /\bhow are (you|ya)\b/i },
  { id: 'how_you_doing',    re: /\bhow (you|are you) doing\b/i },
  { id: 'is_this_nombre',   re: /\bis this [a-z]{2,}/i },
  { id: 'am_i_speaking',    re: /\bam i speaking\b/i },
  { id: 'speaking_with',    re: /\bspeaking with\b/i },
  { id: 'recorded_line',    re: /\brecord(ed|ing)?( the)? line\b/i },
  { id: 'on_a_recorded',    re: /\bon a record/i },
  { id: 'nice_to_meet',     re: /\bnice to meet\b/i },
  { id: 'how_can_i_help',   re: /\bhow can i help\b/i },
  { id: 'good_morning',     re: /\bgood morning\b/i },
  { id: 'good_afternoon',   re: /\bgood afternoon\b/i },
  { id: 'good_evening',     re: /\bgood evening\b/i },
];

const DEBILES = [
  { id: 'hello',      re: /\bhello\b/i },
  { id: 'hey_hi',     re: /\b(hey|hi)\b/i },
  { id: 'whats_up',   re: /\bwhat'?s up\b/i },
  { id: 'yes_sir',    re: /\b(yes sir|yes ma'?am)\b/i },
  { id: 'okay',       re: /\b(okay|alright|all right)\b/i },
  { id: 'buyer_name', re: /\b(century|first choice|quantum|rise|support)\b/i },
  { id: 'thank_you',  re: /\bthank you\b/i },
  { id: 'appreciate', re: /\bappreciate\b/i },
];

function detectarHumano(texto) {
  const fuertes = FUERTES.filter(m => m.re.test(texto)).map(m => m.id);
  const debiles = DEBILES.filter(m => m.re.test(texto)).map(m => m.id);
  return { dispara: fuertes.length >= 1 || debiles.length >= 2, fuertes, debiles };
}

app.get('/', (req, res) => {
  res.send('v2-human-detector alive');
});

const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws) => {
  console.log('🔌 Stream conectado');

  let conferenceName = null;
  let buyerLabel = 'BUYER';
  let callSid = null;
  let chunkCount = 0;
  let dg = null;
  let dgReady = false;
  let humanoDetectado = false;
  const inicioLlamada = Date.now();
  const bufferAudio = [];   // guarda audio que llega antes de que DG esté listo

  async function moverAConference() {
    if (!conferenceName || !callSid) {
      console.log('⚠️  falta conf o callSid | conf:', conferenceName, '| sid:', callSid);
      return;
    }
    try {
      const twiml = `<Response><Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true">${conferenceName}</Conference></Dial></Response>`;
      await twilioClient.calls(callSid).update({ twiml });
      console.log(`✅ ${buyerLabel} movido a conference ${conferenceName}`);
    } catch (e) {
      console.error('❌ error moviendo a conference:', e.message);
    }
  }

  // ---- LISTENER PRIMERO: no perdemos el evento start ----
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }

    switch (msg.event) {
      case 'connected':
        console.log('✅ connected');
        break;

      case 'start':
        callSid = msg.start.callSid;
        if (msg.start.customParameters) {
          conferenceName = msg.start.customParameters.conf || null;
          buyerLabel = msg.start.customParameters.buyer || 'BUYER';
        }
        console.log(`▶️  start | ${buyerLabel} | conf: ${conferenceName} | callSid: ${callSid}`);
        break;

      case 'media':
        chunkCount++;
        const audio = Buffer.from(msg.media.payload, 'base64');
        if (dgReady && dg) {
          try { dg.sendMedia(audio); } catch (e) {}
        } else if (bufferAudio.length < 500) {
          bufferAudio.push(audio);
        }
        break;

      case 'stop':
        console.log(`⏹️  stop | ${buyerLabel} | chunks: ${chunkCount} | humano: ${humanoDetectado}`);
        if (dg) { try { dg.close(); } catch (e) {} }
        break;
    }
  });

  ws.on('close', () => {
    if (dg) { try { dg.close(); } catch (e) {} }
  });

  ws.on('error', (err) => console.error('❌ WS:', err.message));

  // ---- DEEPGRAM DESPUES ----
  (async () => {
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
              const r = detectarHumano(transcript);
              if (r.dispara) {
                humanoDetectado = true;
                const ms = Date.now() - inicioLlamada;
                console.log('');
                console.log(`🚨 HUMANO DETECTADO en ${buyerLabel} a los ${(ms / 1000).toFixed(1)}s`);
                console.log(`    frase: "${transcript}"`);
                console.log(`    señales: ${[...r.fuertes, ...r.debiles].join(', ')}`);
                console.log('');
                moverAConference();
              }
            }
          }
        }
      });

      dg.on('error', (err) => console.error('❌ Deepgram:', err));
      dg.on('close', () => { dgReady = false; });

      dg.connect();
      await dg.waitForOpen();
      dgReady = true;
      console.log(`🎙️  Deepgram listo (buffer: ${bufferAudio.length} chunks)`);

      // mandamos lo que se acumuló mientras conectaba
      while (bufferAudio.length) {
        try { dg.sendMedia(bufferAudio.shift()); } catch (e) { break; }
      }
    } catch (e) {
      console.error('❌ Deepgram no conectó:', e.message);
    }
  })();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 servidor escuchando en puerto ${PORT}`);
});
