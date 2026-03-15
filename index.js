const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode  = require('qrcode');
const axios   = require('axios');

const PORT        = process.env.PORT || 3000;
const MAIN_APP    = process.env.MAIN_APP_URL || '';   // URL основного приложения
const API_SECRET  = process.env.API_SECRET  || 'changeme';
const WA_SECRET   = process.env.WA_SECRET   || 'changeme';

const app = express();
app.use(express.json({ limit: '20mb' }));

// ── Состояние клиента ─────────────────────────────────────────────────────────
let client       = null;
let qrDataUrl    = null;   // base64 QR PNG
let clientStatus = 'disconnected'; // disconnected | qr | connecting | ready | banned
let clientInfo   = null;

// ── Создание клиента ──────────────────────────────────────────────────────────
function createClient() {
  clearLocks();
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
    const body     = msg.body || '';

    let senderName = number;
    try {
      const contact = await msg.getContact();
      senderName = contact.pushname || contact.name || number;
    } catch (_) {}

    // ── Медиафайлы ────────────────────────────────────────────────────────────
    let mediaBase64 = null;
    let mediaMime   = null;
    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          mediaBase64 = media.data;        // base64 строка
          mediaMime   = media.mimetype;    // image/jpeg, video/mp4, etc.
          console.log(`[WA] Media from ${number}: ${mediaMime}`);
        }
      } catch (e) {
        console.error('[WA] Media download error:', e.message);
      }
    }

    const displayBody = body || (msg.hasMedia ? '[медиафайл]' : '');
    console.log(`[WA] MSG from ${number}: ${displayBody.substring(0, 50)}`);

    // Отправляем в основное приложение
    await notifyMain('message', {
      wa_chat_id:   chatId,
      wa_number:    number,
      sender_name:  senderName,
      body:         displayBody,
      hasMedia:     msg.hasMedia,
      media_base64: mediaBase64,
      media_type:   mediaMime,
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
  try { fs.rmSync(path, { recursive: true, force: true }); } catch (_) {}
  // НЕ создаём папку обратно — чтобы автозапуск не принял пустую папку за сессию
}

// Удаляет lock-файлы Chromium, которые остаются после краша контейнера
function clearLocks() {
  const fs   = require('fs');
  const path = require('path');
  const base = '/app/.wwebjs_auth';
  const lockNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
  function removeLocks(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        removeLocks(full);
      } else if (lockNames.includes(entry.name) || entry.name.endsWith('.lock')) {
        try { fs.unlinkSync(full); console.log('[WA] Removed lock: ' + full); } catch (_) {}
      }
    }
  }
  removeLocks(base);
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

// Отправить медиафайл (base64)
app.post('/send_media', auth, async (req, res) => {
  const { to, base64, mimetype, filename, caption } = req.body;
  if (!to || !base64 || !mimetype) {
    return res.status(400).json({ error: 'to, base64 and mimetype required' });
  }
  if (!client || clientStatus !== 'ready') {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  try {
    const { MessageMedia } = require('whatsapp-web.js');
    const chatId = to.includes('@') ? to : `${to}@c.us`;
    const media  = new MessageMedia(mimetype, base64, filename || 'file');
    await client.sendMessage(chatId, media, { caption: caption || '' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[WA] Send media error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Получить профиль контакта
app.post('/contact_info', auth, async (req, res) => {
  const { wa_chat_id } = req.body;
  if (!wa_chat_id) return res.status(400).json({ error: 'wa_chat_id required' });
  if (!client || clientStatus !== 'ready') {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  try {
    const chatId = wa_chat_id.includes('@') ? wa_chat_id : `${wa_chat_id}@c.us`;
    const contact = await client.getContactById(chatId);
    let photo_url = null;
    try {
      photo_url = await contact.getProfilePicUrl();
    } catch (_) {}
    res.json({
      ok: true,
      name:      contact.pushname || contact.name || null,
      about:     contact.about   || null,
      photo_url: photo_url       || null,
    });
  } catch (e) {
    console.error('[WA] contact_info error:', e.message);
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
  // Автозапуск только если есть реальные данные сессии (папка session внутри)
  const fs   = require('fs');
  const path = require('path');
  const auth = '/app/.wwebjs_auth';
  const sessionDir = path.join(auth, 'session');
  const hasSavedSession = fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0;
  if (hasSavedSession) {
    console.log('[WA] Found saved session — auto-connecting...');
    client = createClient();
  } else {
    console.log('[WA] No saved session — waiting for /connect call');
  }
});
