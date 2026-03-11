# ИНСТРУКЦИЯ: Интеграция WhatsApp в TG Tracker v5
# ================================================

## ШАГ 1 — Деплой WhatsApp сервиса на Railway

1. Создай новый проект на Railway
2. Загрузи файлы из папки `whatsapp_service/` (index.js, package.json, Dockerfile)
3. Railway сам обнаружит Dockerfile и соберёт образ
4. Добавь переменные окружения:

   MAIN_APP_URL    = https://твой-основной-сервис.up.railway.app
   API_SECRET      = придумай_секрет_1
   WA_SECRET       = придумай_секрет_2
   PORT            = 3000

5. Скопируй URL нового сервиса (например: https://wa-service-xxx.up.railway.app)

---

## ШАГ 2 — Добавь переменные в ОСНОВНОЙ Railway сервис

   WA_SERVICE_URL     = https://wa-service-xxx.up.railway.app
   WA_API_SECRET      = тот_же_секрет_1
   WA_WEBHOOK_SECRET  = тот_же_секрет_2

---

## ШАГ 3 — Обнови database.py (v5)

В метод _init_db() добавь в конец executescript():

```python
CREATE TABLE IF NOT EXISTS wa_conversations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_chat_id      TEXT NOT NULL UNIQUE,
    wa_number       TEXT NOT NULL,
    visitor_name    TEXT NOT NULL DEFAULT 'Неизвестный',
    status          TEXT DEFAULT 'open',
    unread_count    INTEGER DEFAULT 0,
    last_message    TEXT,
    last_message_at TEXT,
    fb_event_sent   TEXT,
    created_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wa_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    wa_chat_id      TEXT NOT NULL,
    sender_type     TEXT NOT NULL,
    content         TEXT,
    read_by_manager INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES wa_conversations(id)
);
```

Добавь методы из файла db_patch.py в класс Database.

---

## ШАГ 4 — Обнови main.py (v5)

1. Добавь импорт: `import httpx`
2. Добавь переменные WA_URL, WA_SECRET, WA_WH_SECRET из env
3. Скопируй все маршруты из wa_routes.py в main.py
   (убери комментарии # @app.get/post и добавь декораторы)
4. В nav_html() добавь в секцию СОТРУДНИКИ:
   ```python
   {item("💚", "WA Чаты",  "wa_chat",  "orange")}
   {item("📱", "WA Настройка", "wa_setup", "orange")}
   ```
5. В get_stats() добавь wa статистику из db.get_wa_stats()

---

## ШАГ 5 — Проверка

1. Открой /wa/setup в админке
2. Нажми "Подключить WhatsApp"
3. Отсканируй QR телефоном
4. Напиши сообщение на подключённый номер
5. Сообщение должно появиться в /wa/chat

---

## Смена номера при бане

1. /wa/setup → "Сменить номер (отключить)"
2. Подключи новый номер через QR
3. Все старые чаты сохраняются в базе

---

## Отправка Lead в Facebook из WA чата

1. Открой диалог в /wa/chat
2. Нажми "📤 Отправить Lead в FB"
3. Событие Lead отправится в Meta CAPI с номером телефона как user_id
4. Кнопка заменится на "FB Lead ✓ отправлен"
