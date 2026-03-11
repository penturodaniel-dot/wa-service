"""
wa_routes.py — маршруты WhatsApp для добавления в main.py v5

Добавь импорт: import httpx
Добавь в env: WA_SERVICE_URL, WA_API_SECRET, WA_WEBHOOK_SECRET
"""

import httpx

WA_URL    = os.getenv("WA_SERVICE_URL", "")    # URL WhatsApp сервиса на Railway
WA_SECRET = os.getenv("WA_API_SECRET",  "changeme")
WA_WH_SECRET = os.getenv("WA_WEBHOOK_SECRET", "changeme")


# ── Хелпер вызова WA сервиса ──────────────────────────────────────────────────

async def wa_api(method: str, path: str, **kwargs) -> dict:
    if not WA_URL:
        return {"error": "WA_SERVICE_URL not configured"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await getattr(client, method)(
                f"{WA_URL.rstrip('/')}{path}",
                headers={"X-Api-Secret": WA_SECRET},
                **kwargs
            )
            return resp.json()
    except Exception as e:
        log.error(f"WA API error: {e}")
        return {"error": str(e)}


# ══════════════════════════════════════════════════════════════════════════════
# WEBHOOK — принимает события от WA сервиса
# ══════════════════════════════════════════════════════════════════════════════

# @app.post("/wa/webhook")
async def wa_webhook(request: Request):
    secret = request.headers.get("X-WA-Secret", "")
    if secret != WA_WH_SECRET:
        return JSONResponse({"error": "unauthorized"}, 401)

    body = await request.json()
    event = body.get("event")
    data  = body.get("data", {})

    if event == "message":
        wa_chat_id  = data["wa_chat_id"]
        wa_number   = data["wa_number"]
        sender_name = data.get("sender_name", wa_number)
        text        = data.get("body", "")

        conv = db.get_or_create_wa_conversation(wa_chat_id, wa_number, sender_name)
        db.save_wa_message(conv["id"], wa_chat_id, "visitor", text)
        db.update_wa_last_message(wa_chat_id, text, increment_unread=True)

        # Уведомление менеджеру (через бот 1 или 2)
        notify_chat = db.get_setting("notify_chat_id")
        if notify_chat:
            bot = bot_manager.get_tracker_bot() or bot_manager.get_staff_bot()
            if bot:
                try:
                    from aiogram import types as tg_types
                    preview = text[:80] + "..." if len(text) > 80 else text
                    await bot.send_message(
                        int(notify_chat),
                        f"💚 *WhatsApp — новое сообщение*\n👤 {sender_name} (+{wa_number})\n\n_{preview}_",
                        parse_mode="Markdown",
                        reply_markup=tg_types.InlineKeyboardMarkup(inline_keyboard=[[
                            tg_types.InlineKeyboardButton(
                                text="Открыть WA чат →",
                                url=f"{db.get_setting('app_url', '')}/wa/chat?conv_id={conv['id']}"
                            )
                        ]])
                    )
                except Exception as e:
                    log.warning(f"WA notify error: {e}")
        log.info(f"[WA webhook] message from {wa_number}: {text[:40]}")

    elif event == "ready":
        db.set_setting("wa_connected_number", data.get("number", ""))
        db.set_setting("wa_status", "ready")
        log.info(f"[WA webhook] ready: {data.get('number')}")

    elif event == "disconnected":
        db.set_setting("wa_status", "disconnected")
        db.set_setting("wa_connected_number", "")

    elif event == "qr":
        db.set_setting("wa_qr", data.get("qr", ""))
        db.set_setting("wa_status", "qr")

    return JSONResponse({"ok": True})


# ══════════════════════════════════════════════════════════════════════════════
# WA CHAT PAGE
# ══════════════════════════════════════════════════════════════════════════════

# @app.get("/wa/chat", response_class=HTMLResponse)
async def wa_chat_page(request: Request, conv_id: int = 0):
    user, err = require_auth(request)
    if err: return err

    convs = db.get_wa_conversations()
    wa_stats = db.get_wa_stats()
    messages_html = ""
    header_html   = ""
    active_conv   = None

    if conv_id:
        active_conv = db.get_wa_conversation(conv_id)
        if active_conv:
            db.mark_wa_read(conv_id)
            msgs = db.get_wa_messages(conv_id)
            for m in msgs:
                t = m["created_at"][11:16]
                messages_html += f"""<div class="msg {m['sender_type']}" data-id="{m['id']}">
                  <div class="msg-bubble">{(m['content'] or '').replace('<','&lt;')}</div>
                  <div class="msg-time">{t}</div></div>"""

            fb_sent = active_conv.get("fb_event_sent")
            fb_btn  = f'<span class="badge-green">FB Lead ✓ отправлен</span>' if fb_sent else \
                      f'<form method="post" action="/wa/send_lead" style="display:inline"><input type="hidden" name="conv_id" value="{conv_id}"/><button class="btn-green btn-sm">📤 Отправить Lead в FB</button></form>'

            status_color = "#34d399" if active_conv["status"] == "open" else "#ef4444"
            close_btn = f'<form method="post" action="/wa/close"><input type="hidden" name="conv_id" value="{conv_id}"/><button class="btn-gray btn-sm">✓ Закрыть</button></form>' if active_conv["status"] == "open" else \
                        f'<form method="post" action="/wa/reopen"><input type="hidden" name="conv_id" value="{conv_id}"/><button class="btn-green btn-sm">↺ Открыть</button></form>'

            header_html = f"""<div class="chat-header">
              <div style="display:flex;align-items:center;gap:12px">
                <div style="width:36px;height:36px;border-radius:50%;background:#052e16;display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0">💚</div>
                <div>
                  <div style="font-weight:700;color:#fff">{active_conv['visitor_name']} <span style="color:{status_color};font-size:.74rem">●</span></div>
                  <div style="font-size:.79rem;color:#475569">+{active_conv['wa_number']}</div>
                  <div style="margin-top:4px">{fb_btn}</div>
                </div>
              </div>
              <div style="display:flex;gap:8px;flex-shrink:0">{close_btn}</div>
            </div>"""

    # Список диалогов
    conv_items = ""
    for c in convs:
        cls = "conv-item active" if c["id"] == conv_id else "conv-item"
        t = (c.get("last_message_at") or c["created_at"])[:16].replace("T"," ")
        ucount = f'<span class="unread-num" style="background:#25d366">{c["unread_count"]}</span>' if c["unread_count"] > 0 else ""
        dot = "🟢" if c["status"] == "open" else "⚫"
        conv_items += f"""<a href="/wa/chat?conv_id={c['id']}"><div class="{cls}">
          <div class="conv-name"><span>{dot} {c['visitor_name']}</span>{ucount}</div>
          <div class="conv-preview">{c.get('last_message') or 'Нет сообщений'}</div>
          <div class="conv-time">💚 WA · {t}</div></div></a>"""

    if not conv_items:
        conv_items = '<div class="empty" style="padding:36px 14px">Нет диалогов WhatsApp</div>'

    # Статус WA подключения
    wa_status = db.get_setting("wa_status", "disconnected")
    wa_number = db.get_setting("wa_connected_number", "")
    if wa_status == "ready":
        status_bar = f'<div style="background:#052e16;border:1px solid #166534;border-radius:7px;padding:8px 12px;font-size:.8rem;color:#86efac;margin-bottom:8px">💚 WhatsApp подключён · +{wa_number}</div>'
    elif wa_status == "qr":
        status_bar = f'<div style="background:#422006;border:1px solid #92400e;border-radius:7px;padding:8px 12px;font-size:.8rem;color:#fbbf24;margin-bottom:8px">📱 Ожидает сканирования QR → <a href="/wa/setup" style="color:#fbbf24;text-decoration:underline">Открыть QR</a></div>'
    else:
        status_bar = f'<div style="background:#2d0a0a;border:1px solid #7f1d1d;border-radius:7px;padding:8px 12px;font-size:.8rem;color:#fca5a5;margin-bottom:8px">⚠️ WhatsApp не подключён → <a href="/wa/setup" style="color:#fca5a5;text-decoration:underline">Подключить</a></div>'

    right = f"""{header_html}
    <div class="chat-messages" id="wa-msgs">{messages_html}</div>
    <div class="chat-input"><div class="chat-input-row">
      <textarea id="wa-reply" placeholder="Написать в WhatsApp… (Enter — отправить)" rows="1" onkeydown="handleWaKey(event)"></textarea>
      <button class="send-btn-green" onclick="sendWaMsg()">Отправить</button>
    </div></div>""" if active_conv and active_conv["status"] == "open" else (
        f"""{header_html}<div class="no-conv"><div style="font-size:1.5rem;color:#34d399">💬</div><div>Чат закрыт</div></div>""" if active_conv else
        '<div class="no-conv"><div style="font-size:2.5rem">💚</div><div>Выбери диалог WhatsApp</div></div>'
    )

    WA_SEND_BTN_CSS = ".send-btn-green{background:#25d366;color:#fff;border:none;border-radius:10px;padding:10px 18px;cursor:pointer;font-size:.87rem;font-weight:600;height:42px;flex-shrink:0}.send-btn-green:hover{background:#128c7e}.chat-input textarea:focus{border-color:#25d366}"

    content = f"""<style>{WA_SEND_BTN_CSS}</style>
    <div class="chat-layout">
      <div class="conv-list">
        <div class="conv-search">
          {status_bar}
          <input type="text" placeholder="🔍 Поиск..." oninput="filterConvs(this.value)"/>
        </div>
        <div id="conv-items">{conv_items}</div>
      </div>
      <div class="chat-window">{right}</div>
    </div>
    <script>
    const msgsEl=document.getElementById('wa-msgs');
    if(msgsEl) msgsEl.scrollTop=msgsEl.scrollHeight;

    async function sendWaMsg(){{
      const ta=document.getElementById('wa-reply');
      const text=ta.value.trim(); if(!text) return; ta.value='';
      await fetch('/wa/send',{{method:'POST',headers:{{'Content-Type':'application/x-www-form-urlencoded'}},
        body:'conv_id={conv_id}&text='+encodeURIComponent(text)}});
      loadNewWaMsgs();
    }}
    function handleWaKey(e){{if(e.key==='Enter'&&!e.shiftKey){{e.preventDefault();sendWaMsg();}}}}

    {"setInterval(loadNewWaMsgs,3000);" if active_conv else "setInterval(checkWaUnread,5000);"}

    async function loadNewWaMsgs(){{
      const msgs=document.querySelectorAll('#wa-msgs .msg[data-id]');
      const lastId=msgs.length?msgs[msgs.length-1].dataset.id:0;
      const res=await fetch('/api/wa_messages/{conv_id}?after='+lastId);
      const data=await res.json();
      if(data.messages&&data.messages.length>0){{
        const c=document.getElementById('wa-msgs');
        data.messages.forEach(m=>{{
          const d=document.createElement('div');d.className='msg '+m.sender_type;d.dataset.id=m.id;
          d.innerHTML='<div class="msg-bubble">'+esc(m.content)+'</div><div class="msg-time">'+m.created_at.substring(11,16)+'</div>';
          c.appendChild(d);}});c.scrollTop=c.scrollHeight;}}
    }}
    async function checkWaUnread(){{}}
    function esc(t){{return(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\n/g,'<br>');}}
    function filterConvs(q){{document.querySelectorAll('.conv-item').forEach(el=>{{
      const n=el.querySelector('.conv-name')?.textContent?.toLowerCase()||'';
      el.parentElement.style.display=n.includes(q.toLowerCase())?'':'none';}});}}
    </script>"""

    return HTMLResponse(f'<!DOCTYPE html><html><head><meta charset="utf-8"><title>WhatsApp чаты</title>{CSS}</head><body>{nav_html("wa_chat",request)}<div class="main">{content}</div></body></html>')


# ══════════════════════════════════════════════════════════════════════════════
# WA SETUP PAGE (QR + управление номером)
# ══════════════════════════════════════════════════════════════════════════════

# @app.get("/wa/setup", response_class=HTMLResponse)
async def wa_setup_page(request: Request, msg: str = ""):
    user, err = require_auth(request, role="admin")
    if err: return err

    # Получаем статус от WA сервиса
    wa_data = await wa_api("get", "/status")
    wa_status = wa_data.get("status", "disconnected")
    wa_number = wa_data.get("number", "")

    qr_html = ""
    if wa_status == "qr":
        qr_data = await wa_api("get", "/qr")
        qr = qr_data.get("qr", "")
        if qr:
            qr_html = f"""
            <div style="text-align:center;padding:20px">
              <img src="{qr}" style="width:220px;height:220px;border-radius:12px;border:2px solid #25d366"/>
              <div style="color:#86efac;margin-top:12px;font-size:.88rem">Открой WhatsApp → Связанные устройства → Привязать устройство</div>
              <div style="color:#475569;font-size:.78rem;margin-top:6px">QR обновляется автоматически каждые 20 сек</div>
            </div>"""

    alert = f'<div class="alert-green">✅ {msg}</div>' if msg else ""

    if wa_status == "ready":
        status_html = f'<div style="color:#34d399;font-size:1rem;font-weight:600">💚 Подключён · +{wa_number}</div>'
        action_btn  = f"""
        <div style="margin-top:16px">
          <form method="post" action="/wa/disconnect">
            <button class="btn-red">🔄 Сменить номер (отключить)</button>
          </form>
          <div style="font-size:.78rem;color:#475569;margin-top:6px">После отключения отсканируй QR новым номером</div>
        </div>"""
    elif wa_status == "qr":
        status_html = '<div style="color:#fbbf24;font-size:1rem;font-weight:600">📱 Ожидает QR-сканирования...</div>'
        action_btn  = '<div style="margin-top:12px;font-size:.82rem;color:#475569">Автообновление через <span id="countdown">20</span>с <script>let t=20;setInterval(()=>{{document.getElementById("countdown").textContent=--t;if(t<=0)location.reload()}},1000)</script></div>'
    else:
        status_html = '<div style="color:#f87171;font-size:1rem;font-weight:600">⚠️ Не подключён</div>'
        action_btn  = """
        <div style="margin-top:16px">
          <form method="post" action="/wa/connect">
            <button class="btn-green">💚 Подключить WhatsApp</button>
          </form>
          <div style="font-size:.78rem;color:#475569;margin-top:6px">Появится QR-код для сканирования</div>
        </div>"""

    content = f"""<div class="page-wrap">
    <div class="page-title">💚 WhatsApp — Управление</div>
    <div class="page-sub">Подключение и смена номера</div>
    {alert}
    <div class="section" style="border-left:3px solid #25d366">
      <div class="section-head"><h3>📱 Статус подключения</h3></div>
      <div class="section-body">
        {status_html}
        {qr_html}
        {action_btn}
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h3>ℹ️ Как это работает</h3></div>
      <div class="section-body" style="font-size:.85rem;color:#64748b;line-height:1.8">
        <div>1. Нажми "Подключить WhatsApp" — появится QR-код</div>
        <div>2. Открой WhatsApp на телефоне → Связанные устройства → Привязать устройство</div>
        <div>3. Отсканируй QR — подключение займёт ~10 секунд</div>
        <div>4. Если номер заблокировали → нажми "Сменить номер" → подключи новый</div>
        <div style="margin-top:12px;color:#fbbf24">⚠️ Используй отдельный номер WhatsApp, не основной</div>
      </div>
    </div></div>"""

    return HTMLResponse(base(content, "wa_setup", request))


# ══════════════════════════════════════════════════════════════════════════════
# WA ACTIONS
# ══════════════════════════════════════════════════════════════════════════════

# @app.post("/wa/connect")
async def wa_connect(request: Request):
    user, err = require_auth(request, role="admin")
    if err: return err
    await wa_api("post", "/connect")
    return RedirectResponse("/wa/setup", 303)


# @app.post("/wa/disconnect")
async def wa_disconnect(request: Request):
    user, err = require_auth(request, role="admin")
    if err: return err
    await wa_api("post", "/disconnect")
    db.set_setting("wa_status", "disconnected")
    db.set_setting("wa_connected_number", "")
    return RedirectResponse("/wa/setup?msg=Отключено — подключи новый номер", 303)


# @app.post("/wa/send")
async def wa_send(request: Request, conv_id: int = Form(...), text: str = Form(...)):
    user, err = require_auth(request)
    if err: return JSONResponse({"error": "unauthorized"}, 401)
    conv = db.get_wa_conversation(conv_id)
    if not conv: return JSONResponse({"error": "not found"}, 404)
    result = await wa_api("post", "/send", json={"to": conv["wa_number"], "message": text})
    if not result.get("error"):
        db.save_wa_message(conv_id, conv["wa_chat_id"], "manager", text)
        db.update_wa_last_message(conv["wa_chat_id"], f"Вы: {text}", increment_unread=False)
    return JSONResponse({"ok": not result.get("error"), "error": result.get("error")})


# @app.post("/wa/send_lead")  ← кнопка "Отправить Lead в FB" из WA чата
async def wa_send_lead(request: Request, conv_id: int = Form(...)):
    user, err = require_auth(request)
    if err: return err
    conv = db.get_wa_conversation(conv_id)
    if not conv: return RedirectResponse("/wa/chat", 303)
    if conv.get("fb_event_sent"):
        return RedirectResponse(f"/wa/chat?conv_id={conv_id}", 303)

    pixel_id   = db.get_setting("pixel_id")
    meta_token = db.get_setting("meta_token")
    sent = await meta_capi.send_lead_event(
        pixel_id, meta_token,
        user_id=conv["wa_number"],   # номер телефона как user_id
        campaign="whatsapp",
    )
    if sent:
        db.set_wa_fb_event(conv_id, "Lead")
    return RedirectResponse(f"/wa/chat?conv_id={conv_id}", 303)


# @app.post("/wa/close")
async def wa_close(request: Request, conv_id: int = Form(...)):
    user, err = require_auth(request)
    if err: return err
    db.close_wa_conversation(conv_id)
    return RedirectResponse(f"/wa/chat?conv_id={conv_id}", 303)


# @app.post("/wa/reopen")
async def wa_reopen(request: Request, conv_id: int = Form(...)):
    user, err = require_auth(request)
    if err: return err
    db.reopen_wa_conversation(conv_id)
    return RedirectResponse(f"/wa/chat?conv_id={conv_id}", 303)


# @app.get("/api/wa_messages/{conv_id}")
async def api_wa_messages(request: Request, conv_id: int, after: int = 0):
    user = check_session(request)
    if not user: return JSONResponse({"error": "unauthorized"}, 401)
    return JSONResponse({"messages": db.get_new_wa_messages(conv_id, after)})
