const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { DeepgramClient } = require('@deepgram/sdk');
const twilio = require('twilio');

const app = express();
const server = http.createServer(app);

const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const RETELL_SIP_HOST = 'sip.retellai.com';
const TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 5;

// ============================================================
//  REGISTRO COMPARTIDO POR CONFERENCE
// ============================================================
const carreras = new Map();

function getCarrera(conf) {
  if (!conf) return null;
  if (!carreras.has(conf)) {
    carreras.set(conf, { ganador: null, piernas: {}, agotados: new Set(), buyers: new Set(), rootSid: null });
  }
  return carreras.get(conf);
}

function registrarPierna(conf, label, callSid, rootSid) {
  const c = getCarrera(conf);
  if (!c) return;
  c.piernas[label] = callSid;
  c.buyers.add(label);
  if (rootSid) c.rootSid = rootSid;
}

function hayGanador(conf) {
  const c = conf && carreras.get(conf);
  return !!(c && c.ganador !== null);
}

function marcarGanador(conf, label) {
  const c = conf && carreras.get(conf);
  if (!c || c.ganador !== null) return false;
  c.ganador = label;
  return true;
}

async function cancelarPerdedores(conf, ganadorLabel) {
  const c = conf && carreras.get(conf);
  if (!c) return;
  for (const [label, sid] of Object.entries(c.piernas)) {
    if (label === ganadorLabel) continue;
    try {
      await twilioClient.calls(sid).update({ status: 'completed' });
      console.log(`   ✂️  cancelado ${label}`);
    } catch (e) {
      console.log(`   ⚠️  no pude cancelar ${label}: ${e.message}`);
    }
  }
}

async function marcarAgotado(conf, label) {
  const c = conf && carreras.get(conf);
  if (!c) return;
  c.agotados.add(label);
  console.log(`   🚫 ${label} agotó sus ${MAX_ATTEMPTS} intentos`);

  const todosAgotados = [...c.buyers].every(b => c.agotados.has(b));
  if (todosAgotados && c.ganador === null && c.rootSid) {
    console.log(`   ☠️  todos los buyers agotados -> cortando al lead`);
    try {
      await twilioClient.calls(c.rootSid).update({
        twiml: '<Response><Say language="en-US">We could not connect you right now. Goodbye.</Say><Hangup/></Response>',
      });
    } catch (e) {
      console.error('   ❌ error cortando al lead:', e.message);
    }
    carreras.delete(conf);
  }
}

async function reintentarBuyer(conf, label, number, attempt, leadName, leadDebt, leadPhone, rootSid) {
  const siguiente = attempt + 1;
  if (siguiente > MAX_ATTEMPTS) {
    await marcarAgotado(conf, label);
    return;
  }
  try {
    const twiml =
      '<Response><Start>' +
      '<Stream url="wss://v2-human-detector.fly.dev/stream" track="inbound_track">' +
      `<Parameter name="conf" value="${conf}"/>` +
      `<Parameter name="buyer" value="${label}"/>` +
      `<Parameter name="buyer_number" value="${number}"/>` +
      `<Parameter name="attempt" value="${siguiente}"/>` +
      `<Parameter name="lead_name" value="${leadName}"/>` +
      `<Parameter name="lead_debt" value="${leadDebt}"/>` +
      `<Parameter name="lead_phone" value="${leadPhone}"/>` +
      `<Parameter name="root_sid" value="${rootSid}"/>` +
      '</Stream></Start>' +
      '<Pause length="300"/></Response>';

    const c = await twilioClient.calls.create({
      to: number,
      from: process.env.INTRO_FROM_NUMBER || '+17274351309',
      twiml,
    });
    console.log(`   🔁 reintento ${siguiente}/${MAX_ATTEMPTS} a ${label} | sid: ${c.sid}`);
  } catch (e) {
    console.error(`   ❌ error reintentando ${label}:`, e.message);
    await marcarAgotado(conf, label);
  }
}

// ============================================================
//  DETECTOR DE SALUDO HUMANO
// ============================================================

// LISTA NEGRA: frases inequívocas de IVR/grabación.
// Si aparece cualquiera, NO se dispara aunque haya otras señales.
const IVR_BLOCKERS = [
  /\bthank you for calling\b/i,
  /\bthanks for calling\b/i,
  /\boffice(s)? (are |is )?(currently )?closed\b/i,
  /\boffice hours\b/i,
  /\bbusiness hours\b/i,
  /\bplease (leave|call back|hold|stay|listen|press|visit)\b/i,
  /\bleave a message\b/i,
  /\bafter the (tone|beep)\b/i,
  /\bpress (one|two|three|four|five|six|seven|eight|nine|zero|pound|star|\d)\b/i,
  /\bfor further options\b/i,
  /\byour call is (very )?important\b/i,
  /\bnext available (agent|representative)\b/i,
  /\bcurrently unavailable\b/i,
  /\bunable to take your call\b/i,
  /\brecord your message\b/i,
  /\bmailbox\b/i,
  /\bvoicemail\b/i,
  /\bmonday through friday\b/i,
  /\bdot com\b/i,
  /\bw w w\b/i,
  /\byou can (view|check|log)\b/i,
  /\bdid you know\b/i,
  /\bthank you for choosing\b/i,
  /\bto speak (to|with) a\b/i,
];

// FUERTES: dispara sola. Un IVR grabado no dice esto de forma dirigida.
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

// DEBILES: necesitan 2. Sin thank_you ni buyer_name (puro IVR).
const DEBILES = [
  { id: 'hello',      re: /\bhello\b/i },
  { id: 'hey_hi',     re: /\b(hey|hi)\b/i },
  { id: 'whats_up',   re: /\bwhat'?s up\b/i },
  { id: 'yes_sir',    re: /\b(yes sir|yes ma'?am)\b/i },
  { id: 'okay',       re: /\b(okay|alright|all right)\b/i },
  { id: 'appreciate', re: /\bappreciate\b/i },
];

function detectarHumano(texto) {
  // 1. si huele a IVR, se corta acá
  const blocker = IVR_BLOCKERS.find(re => re.test(texto));
  if (blocker) {
    return { dispara: false, bloqueado: blocker.source, fuertes: [], debiles: [] };
  }
  const fuertes = FUERTES.filter(m => m.re.test(texto)).map(m => m.id);
  const debiles = DEBILES.filter(m => m.re.test(texto)).map(m => m.id);
  return { dispara: fuertes.length >= 1 || debiles.length >= 2, bloqueado: null, fuertes, debiles };
}

app.get('/', (req, res) => {
  res.send('v2-human-detector alive');
});

const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws) => {
  console.log('🔌 Stream conectado');

  let conferenceName = null;
  let buyerLabel = 'BUYER';
  let buyerNumber = '';
  let attempt = 1;
  let leadName = '';
  let leadDebt = '';
  let leadPhone = '';
  let rootSid = '';
  let callSid = null;
  let chunkCount = 0;
  let dg = null;
  let dgReady = false;
  let yaProcesado = false;
  let timerReintento = null;
  const inicioLlamada = Date.now();
  const bufferAudio = [];

  function cancelarTimer() {
    if (timerReintento) { clearTimeout(timerReintento); timerReintento = null; }
  }

  function armarTimer() {
    cancelarTimer();
    timerReintento = setTimeout(async () => {
      if (yaProcesado || hayGanador(conferenceName)) return;
      console.log(`⏱️  ${buyerLabel} sin humano en ${TIMEOUT_MS / 1000}s (intento ${attempt}/${MAX_ATTEMPTS})`);
      yaProcesado = true;
      try { await twilioClient.calls(callSid).update({ status: 'completed' }); } catch (e) {}
      await reintentarBuyer(conferenceName, buyerLabel, buyerNumber, attempt, leadName, leadDebt, leadPhone, rootSid);
    }, TIMEOUT_MS);
  }

  async function legTerminado(motivo) {
    if (yaProcesado || hayGanador(conferenceName)) return;
    yaProcesado = true;
    cancelarTimer();
    console.log(`⚰️  ${buyerLabel} leg terminado (${motivo}) | intento ${attempt}/${MAX_ATTEMPTS}`);
    await reintentarBuyer(conferenceName, buyerLabel, buyerNumber, attempt, leadName, leadDebt, leadPhone, rootSid);
  }

  async function moverAConference() {
    try {
      const twiml = `<Response><Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true">${conferenceName}</Conference></Dial></Response>`;
      await twilioClient.calls(callSid).update({ twiml });
      console.log(`✅ ${buyerLabel} movido a conference ${conferenceName}`);
    } catch (e) {
      console.error('❌ error moviendo a conference:', e.message);
    }
  }

  async function meterAgenteIntro() {
    try {
      const r = await fetch('https://api.retellai.com/v2/register-phone-call', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + process.env.RETELL_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agent_id: process.env.RETELL_INTRO_AGENT_ID,
          direction: 'inbound',
          retell_llm_dynamic_variables: {
            contact_first_name: leadName || 'the business owner',
            mca_debt_total: leadDebt || '',
            user_number: leadPhone || '',
          },
        }),
      });
      const reg = await r.json();
      if (!reg.call_id) {
        console.error('❌ intro: Retell no dio call_id', JSON.stringify(reg).slice(0, 200));
        return;
      }

      const confTwiml =
        `<Response><Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="false">${conferenceName}</Conference></Dial></Response>`;

      const introCall = await twilioClient.calls.create({
        to: `sip:${reg.call_id}@${RETELL_SIP_HOST}`,
        from: process.env.INTRO_FROM_NUMBER || '+17274351309',
        twiml: confTwiml,
      });

      console.log(`🗣️  agente de intro entrando | sid: ${introCall.sid}`);
    } catch (e) {
      console.error('❌ error metiendo agente de intro:', e.message);
    }
  }

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }

    switch (msg.event) {
      case 'connected':
        break;

      case 'start':
        callSid = msg.start.callSid;
        if (msg.start.customParameters) {
          const p = msg.start.customParameters;
          conferenceName = p.conf || null;
          buyerLabel = p.buyer || 'BUYER';
          buyerNumber = p.buyer_number || '';
          attempt = parseInt(p.attempt || '1', 10);
          leadName = p.lead_name || '';
          leadDebt = p.lead_debt || '';
          leadPhone = p.lead_phone || '';
          rootSid = p.root_sid || '';
        }
        registrarPierna(conferenceName, buyerLabel, callSid, rootSid);
        console.log(`▶️  ${buyerLabel} intento ${attempt}/${MAX_ATTEMPTS} | conf: ${conferenceName}`);
        armarTimer();
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
        if (dg) { try { dg.close(); } catch (e) {} }
        legTerminado('stop');
        break;
    }
  });

  ws.on('close', () => {
    if (dg) { try { dg.close(); } catch (e) {} }
    legTerminado('ws_close');
  });

  ws.on('error', (err) => console.error('❌ WS:', err.message));

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
            console.log(`📝 [${buyerLabel}] ${transcript}`);

            if (!yaProcesado && !hayGanador(conferenceName)) {
              const r = detectarHumano(transcript);
              if (r.bloqueado) {
                console.log(`   🛑 IVR detectado (${r.bloqueado}) — no dispara`);
                return;
              }
              if (r.dispara) {
                yaProcesado = true;
                cancelarTimer();
                const gane = marcarGanador(conferenceName, buyerLabel);
                if (!gane) {
                  console.log(`   (otro buyer ya ganó, ignoro ${buyerLabel})`);
                  return;
                }
                const ms = Date.now() - inicioLlamada;
                console.log('');
                console.log(`🚨 HUMANO DETECTADO en ${buyerLabel} a los ${(ms / 1000).toFixed(1)}s (intento ${attempt})`);
                console.log(`    frase: "${transcript}"`);
                console.log(`    señales: ${[...r.fuertes, ...r.debiles].join(', ')}`);
                console.log('');
                cancelarPerdedores(conferenceName, buyerLabel);
                moverAConference();
                meterAgenteIntro();
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

