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
const QA_DELAY_MS = 5 * 60 * 1000;   // 5 minutos: control de calidad del transfer
// agente de intro por agent_key. Cada uno se presenta con su nombre y marca.
// numero de origen por agente: los reintentos y el agente de intro
// salen desde el numero real del agente, nunca desde uno fijo.
const AGENT_FROM_NUMBERS = {
  sara: '+18455061524',
  anna: '+15755776848',
  kate: '+16615603867',
};

const INTRO_AGENTS = {
  sara: 'agent_246d82bf5f6708067a4913fbae',
  anna: 'agent_693bab08a5c12de681337604c3',
  kate: 'agent_6f6ac7991fc0831f4abd78524b',
};

const GHL_LOCATION_ID = 'NXZFG9aQz6r1UXzZoedy';
const GHL_CONTACT_SEARCH_URL = 'https://services.leadconnectorhq.com/contacts/search';

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

async function reintentarBuyer(conf, label, number, attempt, leadName, leadDebt, leadPhone, rootSid, agentKey) {
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
      `<Parameter name="agent_key" value="${agentKey}"/>` +
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
      from: AGENT_FROM_NUMBERS[agentKey] || process.env.INTRO_FROM_NUMBER,
      twiml,
    });
    console.log(`   🔁 reintento ${siguiente}/${MAX_ATTEMPTS} a ${label} | sid: ${c.sid}`);
  } catch (e) {
    console.error(`   ❌ error reintentando ${label}:`, e.message);
    await marcarAgotado(conf, label);
  }
}

// ============================================================
//  HELPERS DE DATOS
// ============================================================

function s(v) {
  if (v === null || v === undefined) return '';
  const t = String(v).trim();
  if (!t || t.includes('{{') || t.includes('}}')) return '';
  return t;
}

function toIsoDate(v) {
  const raw = s(v);
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // GHL devuelve dateOfBirth como timestamp en milisegundos (ej. 658281600000).
  // Parsearlo como texto falla y el buyer recibe la fecha vacia.
  if (/^-?\d{10,13}$/.test(raw)) {
    const ms = raw.length <= 10 ? Number(raw) * 1000 : Number(raw);
    const dt = new Date(ms);
    return isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
  }
  const d = new Date(raw);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function toNationalPhone(v) {
  const digits = s(v).replace(/[^0-9]/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function toNumber(v) {
  const n = String(s(v)).replace(/[^0-9.]/g, '');
  return n === '' ? '' : String(Number(n));
}

async function buscarContactoGHL(phone) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const r = await fetch(GHL_CONTACT_SEARCH_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.GHL_PRIVATE_INTEGRATION_TOKEN}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        locationId: GHL_LOCATION_ID,
        pageLimit: 3,
        filters: [{ field: 'phone', operator: 'eq', value: phone }],
      }),
    });
    if (!r.ok) {
      console.error('   ❌ GHL search fallo:', r.status);
      return null;
    }
    const data = await r.json();
    const contacts = Array.isArray(data.contacts) ? data.contacts : [];
    return contacts[0] || null;
  } catch (e) {
    console.error('   ❌ GHL search error:', e.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// GHL devuelve los custom fields SOLO con su ID interno, nunca con el nombre.
// Buscarlos por nombre siempre falla y el buyer recibe el lead con campos vacios.
// Si se crea un campo nuevo en GHL, agregarlo aca
// (GET /locations/{id}/customFields lista todos).
const CF_IDS = Object.freeze({
  Wwfo9AgAhsWDaC0X92fN: 'state_abb',
  AmWaQD4N9LeNS5IC6vqA: 'credit_card_debt',
  h5IfedXXr4XpqJMTp1c6: 'mca_debt_total',
  uGu8Wki98qbiNm0VOlqI: 'weekly_mca_payment',
  W3IDP3yQoHcNaMlgImz5: 'monthly_payment',
  '5YhnLnXIFcgBQDWZwsoc': 'hardship',
  WjBAR7mpEbKUBMbIoIp8: 'business_operating',
  GBKoQX8B53Uop1mrEu9T: 'affordable',
  N6TtGsAs5eMGUZQ0SJKZ: 'accounts_in_default',
  XaXl6ZiwOdV7ezJUYDm9: 'legal_notices_or_liens',
  '1Dx0EmFl4j3yGGszs494': 'closer',
  '12QlJpsyMsXbAwJiWN3K': 'opener',
  '5YdVdXFnxlyHnBwhDVAW': 'business_owner',
});

function armarVariables(c, fallbackPhone, fallbackDebt) {
  const campos = {};
  const raw = (c && c.customFields) || [];
  if (Array.isArray(raw)) {
    for (const f of raw) {
      const key = CF_IDS[f.id];
      if (key) campos[key] = s(f.value !== undefined ? f.value : f.fieldValue);
    }
  }
  const cv = (k) => campos[k] || '';

  const phone = s(c.phone) || s(fallbackPhone);
  const debt = s(cv('credit_card_debt')) || s(c.credit_card_debt) || s(fallbackDebt);
  const first = s(c.firstName);
  const last = s(c.lastName);

  return {
    ghl_contact_id: s(c.id),
    first_name: first,
    last_name: last,
    full_name: s(c.contactName) || [first, last].filter(Boolean).join(' '),
    email: s(c.email),
    phone: phone,
    phone_national: toNationalPhone(phone),
    state: (s(cv('state_abb')) || s(c.state)).toUpperCase(),
    address: s(c.address1),
    city: s(c.city),
    zip_code: s(c.postalCode),
    company_name: s(c.companyName) || s(c.businessName),
    debt: debt,
    debt_number: toNumber(debt),
    date_birth: toIsoDate(s(c.dateOfBirth) || s(cv('date_birth'))),
    date_birth_iso: toIsoDate(s(c.dateOfBirth) || s(cv('date_birth'))),
    mca_debt_total: s(cv('mca_debt_total')),
    weekly_mca_payment: s(cv('weekly_mca_payment')),
    hardship: s(cv('hardship')),
    business_operating: s(cv('business_operating')),
    affordable: s(cv('affordable')),
    accounts_in_default: s(cv('accounts_in_default')),
    legal_notices_or_liens: s(cv('legal_notices_or_liens')),
    closer: s(cv('closer')),
    opener: s(cv('opener')),
  };
}

function rellenarTemplate(template, vars) {
  const out = {};
  for (const [k, v] of Object.entries(template)) {
    out[k] = String(v).replace(/\{\{(\w+)\}\}/g, (_, name) => vars[name] ?? '');
  }
  return out;
}

async function traerBuyer(label) {
  try {
    const q = process.env.SUPABASE_URL +
      '/rest/v1/v2_buyers?label=eq.' + encodeURIComponent(label) +
      '&select=label,webhook_url,webhook_method,webhook_headers,webhook_content_type,webhook_template,webhook_active';
    const r = await fetch(q, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      },
    });
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (e) {
    console.error('   ❌ error trayendo buyer:', e.message);
    return null;
  }
}

// manda el lead al CRM del buyer. devuelve el ghl_contact_id para el QA posterior.
async function dispararWebhookBuyer(buyerLabel, leadPhone, leadDebt) {
  let contactId = '';
  try {
    const contacto = await buscarContactoGHL(leadPhone);
    if (!contacto) {
      console.error(`   ❌ no encontre el contacto en GHL (${leadPhone})`);
      return '';
    }
    const vars = armarVariables(contacto, leadPhone, leadDebt);
    contactId = vars.ghl_contact_id;

    const buyer = await traerBuyer(buyerLabel);
    if (!buyer || !buyer.webhook_active || !buyer.webhook_url || !buyer.webhook_template) {
      console.log(`   ℹ️  ${buyerLabel} sin webhook activo — no se manda nada al CRM`);
      return contactId;
    }

    const payload = rellenarTemplate(buyer.webhook_template, vars);
    const headers = Object.assign({}, buyer.webhook_headers || {});
    let body;
    if (buyer.webhook_content_type === 'form') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(payload).toString();
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(payload);
    }

    const r = await fetch(buyer.webhook_url, {
      method: buyer.webhook_method || 'POST',
      headers,
      body,
    });

    if (r.ok) {
      console.log(`   📤 webhook ${buyerLabel} OK (${r.status}) | contacto ${contactId}`);
    } else {
      const txt = await r.text().catch(() => '');
      console.error(`   ❌ webhook ${buyerLabel} fallo ${r.status}: ${txt.slice(0, 200)}`);
    }
  } catch (e) {
    console.error(`   ❌ webhook ${buyerLabel} error:`, e.message);
  }
  return contactId;
}

// ============================================================
//  CONTROL DE CALIDAD A LOS 5 MINUTOS
//  Si la llamada del lead sigue viva -> sustained true (transfer cobrable)
// ============================================================
async function programarQA(datos) {
  const { rootSid, buyerLabel, leadPhone, retellCallId, detectedAt, detectionSeconds, attempt, contactIdPromise } = datos;

  setTimeout(async () => {
    let callStatus = 'unknown';
    let durationSeconds = 0;
    let sustained = false;

    try {
      const call = await twilioClient.calls(rootSid).fetch();
      callStatus = call.status;
      durationSeconds = parseInt(call.duration || '0', 10);
      sustained = call.status === 'in-progress';
    } catch (e) {
      console.error('   ❌ QA: no pude leer la llamada:', e.message);
    }

    const ghlContactId = (await contactIdPromise) || '';

    const payload = {
      sustained: sustained,
      buyer: buyerLabel,
      ghl_contact_id: ghlContactId,
      lead_phone: leadPhone,
      retell_call_id: retellCallId,
      root_call_sid: rootSid,
      detected_at: detectedAt,
      detection_seconds: detectionSeconds,
      attempt: attempt,
      call_status: callStatus,
      call_duration_seconds: durationSeconds,
      checked_at: new Date().toISOString(),
    };

    console.log('');
    console.log(`⏳ QA 5min | ${buyerLabel} | sustained: ${sustained} | status: ${callStatus} | dur: ${durationSeconds}s`);

    try {
      const url = process.env.GHL_QA_WEBHOOK_URL;
      if (!url) {
        console.log('   ℹ️  QA: falta GHL_QA_WEBHOOK_URL, no se manda');
        return;
      }
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        console.log(`   📤 QA webhook a GHL OK (${r.status})`);
      } else {
        const txt = await r.text().catch(() => '');
        console.error(`   ❌ QA webhook fallo ${r.status}: ${txt.slice(0, 200)}`);
      }
    } catch (e) {
      console.error('   ❌ QA webhook error:', e.message);
    }
  }, QA_DELAY_MS);

  console.log(`   ⏱️  QA programado en 5 min para ${buyerLabel}`);
}

// ============================================================
//  DETECTOR DE SALUDO HUMANO
// ============================================================
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
  { id: 'appreciate', re: /\bappreciate\b/i },
];

function detectarHumano(texto) {
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
  let agentKey = '';
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
      await reintentarBuyer(conferenceName, buyerLabel, buyerNumber, attempt, leadName, leadDebt, leadPhone, rootSid, agentKey);
    }, TIMEOUT_MS);
  }

  async function legTerminado(motivo) {
    if (yaProcesado || hayGanador(conferenceName)) return;
    yaProcesado = true;
    cancelarTimer();
    console.log(`⚰️  ${buyerLabel} leg terminado (${motivo}) | intento ${attempt}/${MAX_ATTEMPTS}`);
    await reintentarBuyer(conferenceName, buyerLabel, buyerNumber, attempt, leadName, leadDebt, leadPhone, rootSid, agentKey);
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
          agent_id: INTRO_AGENTS[agentKey] || process.env.RETELL_INTRO_AGENT_ID,
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
        from: AGENT_FROM_NUMBERS[agentKey] || process.env.INTRO_FROM_NUMBER,
        twiml: confTwiml,
      });

      console.log(`🗣️  agente de intro (${agentKey || 'default'}) entrando | sid: ${introCall.sid}`);
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
          agentKey = (p.agent_key || '').toLowerCase();
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
                const detectedAt = new Date().toISOString();
                console.log('');
                console.log(`🚨 HUMANO DETECTADO en ${buyerLabel} a los ${(ms / 1000).toFixed(1)}s (intento ${attempt})`);
                console.log(`    frase: "${transcript}"`);
                console.log(`    señales: ${[...r.fuertes, ...r.debiles].join(', ')}`);
                console.log('');

                cancelarPerdedores(conferenceName, buyerLabel);
                moverAConference();
                meterAgenteIntro();

                // el webhook al CRM devuelve el ghl_contact_id, que el QA reusa
                const contactIdPromise = dispararWebhookBuyer(buyerLabel, leadPhone, leadDebt);

                programarQA({
                  rootSid,
                  buyerLabel,
                  leadPhone,
                  retellCallId: conferenceName ? conferenceName.replace('transfer_', '') : '',
                  detectedAt,
                  detectionSeconds: Number((ms / 1000).toFixed(1)),
                  attempt,
                  contactIdPromise,
                });
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
