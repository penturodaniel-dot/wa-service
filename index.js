const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode  = require('qrcode');
const axios   = require('axios');

const PORT        = process.env.PORT || 3000;
const MAIN_APP    = process.env.MAIN_APP_URL || '';   // URL основного приложения
const API_SECRET  = process.env.API_SECRET  || 'changeme';
const WA_SECRET   = process.env.WA_SECRET   || 'changeme';

const app = express();
app.use(express.json());

// ── Состояние клиента ─────────────────────────────────────────────────────────
let client       = null;
let qrDataUrl    = null;   // base64 QR PNG
let clientStatus = 'disconnected'; // disconnected | qr | connecting | ready | banned
let clientInfo   = null;

// ── Создание клиента ──────────────────────────────────────────────────────────
function createClient() {
  console.log('[WA] Creating client...');
  clientStatus = 'connecting';
  qrDataUrl    = null;

  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }),
    puppeteer: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
      headless: true,
    },
  });

  c.on('qr', async (qr) => {
    console.log('[WA] QR received');
    clientStatus = 'qr';
    qrDataUrl = await qrcode.toDataURL(qr);
    // Уведомляем основное приложение что нужен QR
    notifyMain('qr', { qr: qrDataUrl });
  });

  c.on('ready', async () => {
    clientStatus = 'ready';
    qrDataUrl    = null;
    clientInfo   = c.info;
    console.log(`[WA] Ready! Number: ${c.info.wid.user}`);
    notifyMain('ready', { number: c.info.wid.user, name: c.info.pushname });
  });

  c.on('disconnected', (reason) => {
    console.log('[WA] Disconnected:', reason);
    clientStatus = reason === 'CONFLICT' ? 'banned' : 'disconnected';
    clientInfo   = null;
    notifyMain('disconnected', { reason });
  });

  c.on('auth_failure', () => {
    console.log('[WA] Auth failure — clearing session');
    clientStatus = 'disconnected';
    clearSession();
  });

  // ── Входящие сообщения ──────────────────────────────────────────────────────
  c.on('message', async (msg) => {
    if (msg.fromMe) return;                       // пропускаем исходящие
    if (msg.from.endsWith('@g.us')) return;       // пропускаем группы

    const chatId   = msg.from;                    // номер@c.us
    const number   = chatId.split('@')[0];
    const body     = msg.body || '[медиафайл]';

    let senderName = number;
    try {
      const contact = await msg.getContact();
      senderName = contact.pushname || contact.name || number;
    } catch (_) {}

    console.log(`[WA] MSG from ${number}: ${body.substring(0, 50)}`);

    // Отправляем в основное приложение
    await notifyMain('message', {
      wa_chat_id:   chatId,
      wa_number:    number,
      sender_name:  senderName,
      body,
      timestamp:    Math.floor(Date.now() / 1000),
    });
  });

  c.initialize();
  return c;
}

// ── Уведомление основного приложения ─────────────────────────────────────────
async function notifyMain(event, data) {
  if (!MAIN_APP) return;
  try {
    await axios.post(`${MAIN_APP}/wa/webhook`, { event, data }, {
      headers: { 'X-WA-Secret': WA_SECRET },
      timeout: 5000,
    });
  } catch (e) {
    console.error('[WA] notifyMain error:', e.message);
  }
}

function clearSession() {
  const fs   = require('fs');
  const path = '/app/.wwebjs_auth';
  try { fs.rmSync(path, { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(path); } catch (_) {}
}

// ── AUTH middleware ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  const secret = req.headers['x-api-secret'] || req.query.secret;
  if (secret !== API_SECRET) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ══════════════════════════════════════════════════════════════════════════════
// REST API
// ══════════════════════════════════════════════════════════════════════════════

// Статус
app.get('/status', auth, (req, res) => {
  res.json({
    status:     clientStatus,
    number:     clientInfo?.wid?.user || null,
    name:       clientInfo?.pushname  || null,
    has_qr:     !!qrDataUrl,
  });
});

// QR код
app.get('/qr', auth, (req, res) => {
  if (!qrDataUrl) return res.json({ qr: null, status: clientStatus });
  res.json({ qr: qrDataUrl, status: clientStatus });
});

// Подключить (запустить клиент)
app.post('/connect', auth, (req, res) => {
  if (client && clientStatus === 'ready') {
    return res.json({ ok: true, message: 'Already connected' });
  }
  client = createClient();
  res.json({ ok: true, message: 'Connecting...' });
});

// Отключить и сбросить сессию (смена номера)
app.post('/disconnect', auth, async (req, res) => {
  try {
    if (client) {
      await client.destroy();
      client = null;
    }
    clearSession();
    clientStatus = 'disconnected';
    clientInfo   = null;
    qrDataUrl    = null;
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Отправить сообщение
app.post('/send', auth, async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });
  if (!client || clientStatus !== 'ready') {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  try {
    // to может быть: "79001234567" или "79001234567@c.us"
    const chatId = to.includes('@') ? to : `${to}@c.us`;
    await client.sendMessage(chatId, message);
    res.json({ ok: true });
  } catch (e) {
    console.error('[WA] Send error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, status: clientStatus });
});

// ── Старт ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[WA] Service running on port ${PORT}`);
  // Автозапуск при наличии сохранённой сессии
  const fs   = require('fs');
  const auth = '/app/.wwebjs_auth';
  const hasSavedSession = fs.existsSync(auth) && fs.readdirSync(auth).length > 0;
  if (hasSavedSession) {
    console.log('[WA] Found saved session — auto-connecting...');
    client = createClient();
  } else {
    console.log('[WA] No saved session — waiting for /connect call');
  }
});
