"""
Этот файл — патч для database.py v5.
Добавляет таблицы и методы для WhatsApp чатов.
Вставь содержимое метода _init_wa() в конец _init_db(),
а методы добавь в класс Database.
"""

WA_TABLES = """
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
"""

# ── Добавь эти методы в класс Database ───────────────────────────────────────

# def _init_db(self):  ← добавь WA_TABLES в конец executescript

# def get_or_create_wa_conversation(self, wa_chat_id, wa_number, visitor_name):
#     with self._conn() as conn:
#         row = conn.execute("SELECT * FROM wa_conversations WHERE wa_chat_id=?", (wa_chat_id,)).fetchone()
#         if row: return dict(row)
#         conn.execute("INSERT INTO wa_conversations (wa_chat_id,wa_number,visitor_name,created_at) VALUES (?,?,?,?)",
#                      (wa_chat_id, wa_number, visitor_name, datetime.utcnow().isoformat()))
#         return dict(conn.execute("SELECT * FROM wa_conversations WHERE wa_chat_id=?", (wa_chat_id,)).fetchone())

# def get_wa_conversations(self):
#     with self._conn() as conn:
#         return [dict(r) for r in conn.execute(
#             "SELECT * FROM wa_conversations ORDER BY COALESCE(last_message_at,created_at) DESC").fetchall()]

# def get_wa_conversation(self, conv_id):
#     with self._conn() as conn:
#         row = conn.execute("SELECT * FROM wa_conversations WHERE id=?", (conv_id,)).fetchone()
#         return dict(row) if row else None

# def save_wa_message(self, conv_id, wa_chat_id, sender_type, content):
#     with self._conn() as conn:
#         conn.execute("INSERT INTO wa_messages (conversation_id,wa_chat_id,sender_type,content,created_at) VALUES (?,?,?,?,?)",
#                      (conv_id, wa_chat_id, sender_type, content, datetime.utcnow().isoformat()))

# def get_wa_messages(self, conv_id, limit=100):
#     with self._conn() as conn:
#         return [dict(r) for r in conn.execute(
#             "SELECT * FROM wa_messages WHERE conversation_id=? ORDER BY created_at ASC LIMIT ?",
#             (conv_id, limit)).fetchall()]

# def get_new_wa_messages(self, conv_id, after_id):
#     with self._conn() as conn:
#         return [dict(r) for r in conn.execute(
#             "SELECT * FROM wa_messages WHERE conversation_id=? AND id>? ORDER BY created_at ASC",
#             (conv_id, after_id)).fetchall()]

# def update_wa_last_message(self, wa_chat_id, text, increment_unread=True):
#     with self._conn() as conn:
#         if increment_unread:
#             conn.execute("UPDATE wa_conversations SET last_message=?,last_message_at=?,unread_count=unread_count+1 WHERE wa_chat_id=?",
#                          (text[:100], datetime.utcnow().isoformat(), wa_chat_id))
#         else:
#             conn.execute("UPDATE wa_conversations SET last_message=?,last_message_at=? WHERE wa_chat_id=?",
#                          (text[:100], datetime.utcnow().isoformat(), wa_chat_id))

# def mark_wa_read(self, conv_id):
#     with self._conn() as conn:
#         conn.execute("UPDATE wa_conversations SET unread_count=0 WHERE id=?", (conv_id,))
#         conn.execute("UPDATE wa_messages SET read_by_manager=1 WHERE conversation_id=? AND sender_type='visitor'", (conv_id,))

# def close_wa_conversation(self, conv_id):
#     with self._conn() as conn:
#         conn.execute("UPDATE wa_conversations SET status='closed' WHERE id=?", (conv_id,))

# def reopen_wa_conversation(self, conv_id):
#     with self._conn() as conn:
#         conn.execute("UPDATE wa_conversations SET status='open' WHERE id=?", (conv_id,))

# def set_wa_fb_event(self, conv_id, event):
#     with self._conn() as conn:
#         conn.execute("UPDATE wa_conversations SET fb_event_sent=? WHERE id=?", (event, conv_id))

# def get_wa_stats(self):
#     with self._conn() as conn:
#         total  = conn.execute("SELECT COUNT(*) AS c FROM wa_conversations").fetchone()["c"]
#         unread = conn.execute("SELECT COALESCE(SUM(unread_count),0) AS c FROM wa_conversations").fetchone()["c"]
#         return {"total": total, "unread": unread}
