const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const qrcode  = require('qrcode');
const axios   = require('axios');
const https   = require('https');

const PORT        = process.env.PORT || 3000;
const MAIN_APP    = process.env.MAIN_APP_URL || '';
const API_SECRET  = process.env.API_SECRET  || 'changeme';
const WA_SECRET   = process.env.WA_SECRET   || 'changeme';

// Cloudinary
const CLOUD_NAME  = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLOUD_KEY   = process.env.CLOUDINARY_API_KEY    || '';
const CLOUD_SEC   = process.env.CLOUDINARY_API_SECRET || '';

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

  // Удаляем lock-файлы Chromium — иначе после рестарта контейнера
  // браузер думает что уже запущен на другом компьютере
  const fs = require('fs');
  const lockFiles = [
    '/app/.wwebjs_auth/session/SingletonLock',
    '/app/.wwebjs_auth/session/SingletonCookie',
    '/app/.wwebjs_auth/session/SingletonSocket',
  ];
  lockFiles.forEach(f => { try { fs.unlinkSync(f); console.log('[WA] Removed lock:', f); } catch (_) {} });

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
    let   body     = msg.body || '';

    let senderName = number;
    try {
      const contact = await msg.getContact();
      senderName = contact.pushname || contact.name || number;
    } catch (_) {}

    // Обработка медиафайлов (фото, видео, документы)
    let mediaUrl  = null;
    let mediaType = null;

    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          mediaType = media.mimetype || 'image/jpeg';
          console.log(`[WA] Media received: ${mediaType} from ${number}`);

          // Загружаем в Cloudinary если настроен
          if (CLOUD_NAME && CLOUD_KEY && CLOUD_SEC) {
            const isImage = mediaType.startsWith('image/');
            const uploadType = isImage ? 'image' : 'raw';
            try {
              const crypto = require('crypto');
              const timestamp = Math.floor(Date.now() / 1000);

              // Подпись: параметры строго в алфавитном порядке + secret в конце
              const toSign = `folder=wa_media&timestamp=${timestamp}${CLOUD_SEC}`;
              const signature = crypto.createHash('sha1').update(toSign).digest('hex');

              // Граница для multipart
              const boundary = '----WA' + Date.now();
              const CRLF = '\r\n';

              const addField = (name, value) =>
                `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`;

              let body = '';
              body += addField('timestamp', String(timestamp));
              body += addField('api_key', CLOUD_KEY);
              body += addField('signature', signature);
              body += addField('folder', 'wa_media');

              // Добавляем файл
              const ext = mediaType.split('/')[1] || 'jpg';
              const imgBuffer = Buffer.from(media.data, 'base64');
              const fileHeader = `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="wa.${ext}"${CRLF}Content-Type: ${mediaType}${CRLF}${CRLF}`;
              const fileFooter = `${CRLF}--${boundary}--${CRLF}`;

              const bodyBuffer = Buffer.concat([
                Buffer.from(body),
                Buffer.from(fileHeader),
                imgBuffer,
                Buffer.from(fileFooter),
              ]);

              const res = await axios.post(
                `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/${uploadType}/upload`,
                bodyBuffer,
                {
                  headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuffer.length },
                  timeout: 25000,
                  maxContentLength: 20 * 1024 * 1024,
                }
              );
              mediaUrl = res.data.secure_url || null;
              console.log(`[WA] Uploaded to Cloudinary: ${mediaUrl}`);
            } catch (e) {
              console.error('[WA] Cloudinary error:', e.response?.data ? JSON.stringify(e.response.data) : e.message);
            }
          }

          if (!body) body = mediaType.startsWith('image/') ? '[фото]' : '[файл]';
        }
      } catch (e) {
        console.error('[WA] Media download error:', e.message);
        if (!body) body = '[медиафайл]';
      }
    }

    if (!body) body = '[сообщение]';
    console.log(`[WA] MSG from ${number}: ${body.substring(0, 50)}`);

    // Отправляем в основное приложение
    await notifyMain('message', {
      wa_chat_id:   chatId,
      wa_number:    number,
      sender_name:  senderName,
      body,
      media_url:    mediaUrl,
      media_type:   mediaType,
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

    // Используем getChatById + chat.sendMessage вместо client.sendMessage
    // Это фикс ошибки "No LID for user" на новых аккаунтах WhatsApp
    const chat = await client.getChatById(chatId);
    await chat.sendMessage(message);

    res.json({ ok: true });
  } catch (e) {
    console.error('[WA] Send error:', e.message);

    // Fallback — пробуем старый способ
    try {
      const chatId = to.includes('@') ? to : `${to}@c.us`;
      await client.sendMessage(chatId, message);
      res.json({ ok: true });
    } catch (e2) {
      console.error('[WA] Send fallback error:', e2.message);
      res.status(500).json({ ok: false, error: e2.message });
    }
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, status: clientStatus });
});

// Отправка медиафайла (фото)
app.post('/send_media', auth, async (req, res) => {
  const { to, data, mimetype, filename, caption } = req.body;
  if (!to || !data) return res.status(400).json({ error: 'to and data required' });
  if (!client || clientStatus !== 'ready') {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  try {
    const { MessageMedia } = require('whatsapp-web.js');
    const media = new MessageMedia(mimetype || 'image/jpeg', data, filename || 'photo.jpg');
    const chatId = to.includes('@') ? to : `${to}@c.us`;

    try {
      const chat = await client.getChatById(chatId);
      await chat.sendMessage(media, { caption: caption || '' });
    } catch (_) {
      await client.sendMessage(chatId, media, { caption: caption || '' });
    }

    console.log(`[WA] Media sent to ${to} (${mimetype})`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[WA] send_media error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Старт ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[WA] Service running on port ${PORT}`);

  // Удаляем lock-файлы Chromium — иначе после рестарта контейнера
  // Chromium думает что уже запущен и падает с "profile in use"
  const fs = require('fs');
  const lockFiles = [
    '/app/.wwebjs_auth/session/SingletonLock',
    '/app/.wwebjs_auth/session/SingletonSocket',
    '/app/.wwebjs_auth/session/SingletonCookie',
    '/app/.wwebjs_auth/session/Default/SingletonLock',
  ];
  lockFiles.forEach(f => { try { fs.unlinkSync(f); console.log(`[WA] Removed lock: ${f}`); } catch(_) {} });

  // Автозапуск при наличии сохранённой сессии
  const auth = '/app/.wwebjs_auth';
  const hasSavedSession = fs.existsSync(auth) && fs.readdirSync(auth).length > 0;
  if (hasSavedSession) {
    console.log('[WA] Found saved session — auto-connecting...');
    client = createClient();
  } else {
    console.log('[WA] No saved session — waiting for /connect call');
  }
});
