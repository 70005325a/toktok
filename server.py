#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
톡톡 메신저 — Python 표준 라이브러리만 사용하는 실시간 서버.

기능:
  - SSE(GET /stream) 서버→클라이언트 푸시 + HTTP POST(/api) 클라이언트→서버
  - SQLite(toktok.db) 영구 저장: 서버를 꺼도 채팅방/대화 유지
  - 입장 비밀번호: 환경변수 ACCESS_CODE 설정 시, 맞는 코드만 입장 허용

실행:
  python server.py                         # 기본 포트 4173, 비밀번호 없음
  PORT=8080 python server.py               # 포트 변경
  ACCESS_CODE=1234 python server.py        # 입장 비밀번호 1234
"""

import json
import os
import sys
import queue
import sqlite3
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
DB_PATH = os.path.join(BASE_DIR, "toktok.db")
PORT = int(os.environ.get("PORT", "4173"))
ACCESS_CODE = os.environ.get("ACCESS_CODE", "").strip()
MSG_LIMIT = 500
POLL_WAIT = 25          # 롱폴링 1회 최대 대기(초)
POLL_TIMEOUT_MS = 40000 # 이 시간 동안 폴링 없으면 오프라인 처리

MIME = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml", ".ico": "image/x-icon",
}

# ── 상태 ────────────────────────────────────────────────────
LOCK = threading.RLock()
CLIENTS = {}   # clientId -> {"q": Queue|None, "lastRead": {roomId: ts}, "open": roomId|None}
USERS = {}     # clientId -> {"id","nickname","avatar","status"}
ROOMS = {}     # roomId -> {"id","name","type","participants":[],"avatar","members":set,"messages":[]}

# ── SQLite ──────────────────────────────────────────────────
DB = sqlite3.connect(DB_PATH, check_same_thread=False)
DB.execute("""CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, name TEXT, type TEXT, participants TEXT, avatar TEXT, pinned TEXT)""")
try:
    DB.execute("ALTER TABLE rooms ADD COLUMN pinned TEXT")
except sqlite3.OperationalError:
    pass
DB.execute("""CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, room_id TEXT, sender_id TEXT, nickname TEXT,
    avatar TEXT, text TEXT, kind TEXT, ts INTEGER, deleted INTEGER DEFAULT 0, reply_to TEXT,
    reactions TEXT, edited INTEGER DEFAULT 0, file_name TEXT, duration INTEGER DEFAULT 0)""")
# 기존 DB 마이그레이션 (없는 컬럼만 추가)
for col, ddl in [("reactions", "reactions TEXT"), ("edited", "edited INTEGER DEFAULT 0"),
                 ("file_name", "file_name TEXT"), ("duration", "duration INTEGER DEFAULT 0")]:
    try:
        DB.execute(f"ALTER TABLE messages ADD COLUMN {ddl}")
    except sqlite3.OperationalError:
        pass
DB.commit()


def db_save_room(r):
    DB.execute("INSERT OR REPLACE INTO rooms (id,name,type,participants,avatar,pinned) VALUES (?,?,?,?,?,?)",
               (r["id"], r["name"], r["type"], json.dumps(r["participants"]), r.get("avatar", "💬"),
                r.get("pinned")))
    DB.commit()


def db_save_message(room_id, m):
    DB.execute("INSERT OR REPLACE INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
               (m["id"], room_id, m["senderId"], m["nickname"], m["avatar"], m["text"],
                m["kind"], m["ts"], 1 if m.get("deleted") else 0,
                json.dumps(m["replyTo"]) if m.get("replyTo") else None,
                json.dumps(m["reactions"]) if m.get("reactions") else None,
                1 if m.get("edited") else 0, m.get("fileName"), m.get("duration", 0)))
    DB.commit()


def db_mark_deleted(message_id):
    DB.execute("UPDATE messages SET deleted=1, text='', kind='text' WHERE id=?", (message_id,))
    DB.commit()


def db_delete_room(rid):
    DB.execute("DELETE FROM messages WHERE room_id=?", (rid,))
    DB.execute("DELETE FROM rooms WHERE id=?", (rid,))
    DB.commit()


def db_update_message(m):
    DB.execute("UPDATE messages SET text=?, edited=?, reactions=? WHERE id=?",
               (m["text"], 1 if m.get("edited") else 0,
                json.dumps(m["reactions"]) if m.get("reactions") else None, m["id"]))
    DB.commit()


def db_load():
    for rid, name, rtype, parts, avatar, pinned in DB.execute("SELECT id,name,type,participants,avatar,pinned FROM rooms"):
        ROOMS[rid] = {"id": rid, "name": name, "type": rtype,
                      "participants": json.loads(parts or "[]"), "avatar": avatar or "💬",
                      "members": set(), "messages": [], "pinned": pinned}
    for row in DB.execute("SELECT id,room_id,sender_id,nickname,avatar,text,kind,ts,deleted,reply_to,reactions,edited,file_name,duration FROM messages ORDER BY ts"):
        mid, room_id, sid, nick, avatar, text, kind, ts, deleted, reply_to, reactions, edited, file_name, duration = row
        if room_id not in ROOMS:
            continue
        msg = {"id": mid, "senderId": sid, "nickname": nick, "avatar": avatar,
               "text": text, "kind": kind, "ts": ts}
        if deleted:
            msg["deleted"] = True
        if reply_to:
            msg["replyTo"] = json.loads(reply_to)
        if reactions:
            msg["reactions"] = json.loads(reactions)
        if edited:
            msg["edited"] = True
        if file_name:
            msg["fileName"] = file_name
        if duration:
            msg["duration"] = duration
        ROOMS[room_id]["messages"].append(msg)


def seed_if_empty():
    if ROOMS:
        return
    for name in ["전체 공지방", "자유 수다방", "점심 모임"]:
        rid = str(uuid.uuid4())
        room = {"id": rid, "name": name, "type": "group", "participants": [],
                "avatar": "💬", "members": set(), "messages": []}
        ROOMS[rid] = room
        db_save_room(room)


db_load()
seed_if_empty()


# ── 헬퍼 ────────────────────────────────────────────────────
def ensure_client(cid):
    c = CLIENTS.get(cid)
    if c is None:
        c = {"q": queue.Queue(), "lastRead": {}, "open": None, "lastPoll": 0, "_on": False}
        CLIENTS[cid] = c
    elif c.get("q") is None:
        c["q"] = queue.Queue()
    return c


def is_online(cid):
    c = CLIENTS.get(cid)
    return bool(c and cid in USERS and c.get("lastPoll", 0) > now_ms() - POLL_TIMEOUT_MS)


def push(cid, payload):
    c = CLIENTS.get(cid)
    if c and c.get("q") is not None:
        try:
            c["q"].put_nowait(payload)
        except Exception:
            pass


def room_member_online_count(room):
    return sum(1 for m in room["members"] if is_online(m))


def unread_for_message(room, msg):
    # 카카오톡처럼: 상대가 '읽기 전'이면 오프라인이어도 1 유지.
    # 대상 = DM은 두 참여자, 그룹은 한 번이라도 들어온 멤버.
    targets = room.get("participants") if room["type"] == "dm" else room["members"]
    n = 0
    for mid in (targets or []):
        if mid == msg["senderId"]:
            continue
        last = CLIENTS.get(mid, {}).get("lastRead", {}).get(room["id"], 0)
        if last < msg["ts"]:
            n += 1
    return n


def counts_for_room(room):
    return {m["id"]: unread_for_message(room, m) for m in room["messages"]}


def find_message(room, mid):
    if not mid:
        return None
    return next((m for m in room["messages"] if m["id"] == mid and not m.get("deleted")), None)


def room_display_name(room, viewer_id):
    if room["type"] == "dm":
        other = next((p for p in room["participants"] if p != viewer_id), None)
        u = USERS.get(other)
        return (u["nickname"] if u else "상대"), (u["avatar"] if u else "🙂")
    return room["name"], room.get("avatar", "💬")


def room_summaries_for(cid):
    out = []
    for room in ROOMS.values():
        if room["type"] == "dm" and cid not in room["participants"]:
            continue
        msgs = room["messages"]
        last = msgs[-1] if msgs else None
        last_read = CLIENTS.get(cid, {}).get("lastRead", {}).get(room["id"], 0)
        unread = sum(1 for m in msgs
                     if m["ts"] > last_read and m["senderId"] != cid
                     and m["kind"] != "system" and not m.get("deleted"))
        name, avatar = room_display_name(room, cid)
        last_text = ""
        if last:
            if last.get("deleted"):
                last_text = "삭제된 메시지"
            elif last["kind"] == "image":
                last_text = "📷 사진"
            elif last["kind"] == "file":
                last_text = "📎 파일"
            elif last["kind"] == "audio":
                last_text = "🎤 음성 메시지"
            else:
                last_text = last["text"]  # 텍스트 또는 스티커(이모지)
        out.append({"id": room["id"], "name": name, "type": room["type"], "avatar": avatar,
                    "memberCount": room_member_online_count(room),
                    "lastText": last_text, "lastTs": last["ts"] if last else 0, "unread": unread})
    return out


def send_rooms(cid):
    push(cid, {"type": "rooms", "rooms": room_summaries_for(cid)})


def broadcast_rooms():
    for cid in list(CLIENTS.keys()):
        send_rooms(cid)


def online_users():
    return [USERS[c] for c in CLIENTS if is_online(c) and c in USERS]


def broadcast_online():
    users = online_users()
    for cid in list(CLIENTS.keys()):
        push(cid, {"type": "online", "users": users})


def broadcast_to_room(room, payload):
    for mid in list(room["members"]):
        push(mid, payload)


def broadcast_read_counts(room):
    broadcast_to_room(room, {"type": "read", "roomId": room["id"], "counts": counts_for_room(room)})


def mark_read(cid, room):
    last = room["messages"][-1] if room["messages"] else None
    ensure_client(cid)["lastRead"][room["id"]] = last["ts"] if last else now_ms()


def now_ms():
    return int(time.time() * 1000)


# ── 액션 처리 ───────────────────────────────────────────────
def handle_action(data):
    action = data.get("action")
    cid = data.get("clientId")
    if not cid:
        return {"ok": False}
    c = ensure_client(cid)

    if action == "register":
        if ACCESS_CODE and (data.get("code") or "").strip() != ACCESS_CODE:
            return {"ok": False, "error": "입장 코드가 올바르지 않습니다."}
        USERS[cid] = {"id": cid, "nickname": (data.get("nickname") or "익명")[:20],
                      "avatar": data.get("avatar") or "🙂", "status": (data.get("status") or "")[:60]}
        c["lastPoll"] = now_ms()
        c["_on"] = True
        push(cid, {"type": "welcome", "me": USERS[cid]})
        broadcast_online()
        send_rooms(cid)
        return {"ok": True}

    elif action == "updateProfile":
        u = USERS.get(cid)
        if u:
            if data.get("nickname"):
                u["nickname"] = data["nickname"][:20]
            if data.get("avatar"):
                u["avatar"] = data["avatar"]
            if "status" in data:
                u["status"] = (data.get("status") or "")[:60]
            broadcast_online()
            broadcast_rooms()

    elif action == "createRoom":
        rid = str(uuid.uuid4())
        room = {"id": rid, "name": (data.get("name") or "새 채팅방")[:30], "type": "group",
                "participants": [], "avatar": "💬", "members": set(), "messages": []}
        ROOMS[rid] = room
        db_save_room(room)
        broadcast_rooms()
        push(cid, {"type": "roomCreated", "roomId": rid})

    elif action == "openDM":
        other = data.get("otherId")
        if not other:
            return
        rid = "dm_" + "_".join(sorted([cid, other]))
        if rid not in ROOMS:
            room = {"id": rid, "name": "1:1", "type": "dm", "participants": sorted([cid, other]),
                    "avatar": "🙂", "members": set(), "messages": []}
            ROOMS[rid] = room
            db_save_room(room)
        broadcast_rooms()
        push(cid, {"type": "roomCreated", "roomId": rid})

    elif action == "open":
        room = ROOMS.get(data.get("roomId"))
        if not room:
            return
        room["members"].add(cid)
        CLIENTS[cid]["open"] = room["id"]
        mark_read(cid, room)
        name, _ = room_display_name(room, cid)
        payload = {"type": "history", "roomId": room["id"], "name": name, "roomType": room["type"],
                   "messages": room["messages"], "counts": counts_for_room(room),
                   "memberCount": room_member_online_count(room),
                   "pinned": find_message(room, room.get("pinned"))}
        if room["type"] == "dm":
            other = next((p for p in room["participants"] if p != cid), None)
            payload["peer"] = {"online": is_online(other),
                               "lastSeen": USERS.get(other, {}).get("lastSeen")}
        push(cid, payload)
        broadcast_read_counts(room)
        broadcast_rooms()
        broadcast_online()

    elif action == "close":
        room = ROOMS.get(data.get("roomId"))
        CLIENTS[cid]["open"] = None
        if room:
            mark_read(cid, room)
        send_rooms(cid)

    elif action == "message":
        room = ROOMS.get(data.get("roomId"))
        if not room:
            return
        room["members"].add(cid)
        kind = data.get("kind") if data.get("kind") in ("image", "file", "audio", "sticker") else "text"
        text = data.get("text") or ""
        if kind in ("image", "file", "audio"):
            if not text.startswith("data:") or len(text) > 6_000_000:
                return
        else:
            text = text.strip()[:2000]
            if not text:
                return
        u = USERS.get(cid, {"nickname": "익명", "avatar": "🙂"})
        msg = {"id": str(uuid.uuid4()), "senderId": cid, "nickname": u["nickname"],
               "avatar": u["avatar"], "text": text, "kind": kind, "ts": now_ms()}
        if kind in ("file", "audio"):
            if data.get("fileName"):
                msg["fileName"] = str(data["fileName"])[:120]
            if data.get("duration"):
                try:
                    msg["duration"] = int(data["duration"])
                except Exception:
                    pass
        if data.get("replyTo"):
            r = data["replyTo"]
            msg["replyTo"] = {"id": r.get("id"), "nickname": r.get("nickname", ""), "text": (r.get("text") or "")[:60], "kind": r.get("kind", "text")}
        room["messages"].append(msg)
        db_save_message(room["id"], msg)
        if len(room["messages"]) > MSG_LIMIT:
            room["messages"].pop(0)
        mark_read(cid, room)
        broadcast_to_room(room, {"type": "message", "roomId": room["id"], "message": msg})
        broadcast_read_counts(room)
        broadcast_rooms()

    elif action == "delete":
        room = ROOMS.get(data.get("roomId"))
        if not room:
            return
        for m in room["messages"]:
            if m["id"] == data.get("messageId") and m["senderId"] == cid:
                m["deleted"] = True
                m["text"] = ""
                m["kind"] = "text"
                db_mark_deleted(m["id"])
                break
        broadcast_to_room(room, {"type": "deleted", "roomId": room["id"], "messageId": data.get("messageId")})
        broadcast_rooms()

    elif action == "react":
        room = ROOMS.get(data.get("roomId"))
        emoji = (data.get("emoji") or "")[:8]
        if not room or not emoji:
            return
        for m in room["messages"]:
            if m["id"] == data.get("messageId"):
                reactions = m.setdefault("reactions", {})
                users = reactions.setdefault(emoji, [])
                if cid in users:
                    users.remove(cid)
                    if not users:
                        reactions.pop(emoji, None)
                else:
                    users.append(cid)
                if not reactions:
                    m.pop("reactions", None)
                db_update_message(m)
                broadcast_to_room(room, {"type": "update", "roomId": room["id"], "message": m})
                break

    elif action == "edit":
        room = ROOMS.get(data.get("roomId"))
        if not room:
            return
        text = (data.get("text") or "").strip()[:2000]
        if not text:
            return
        for m in room["messages"]:
            if m["id"] == data.get("messageId") and m["senderId"] == cid and m["kind"] == "text" and not m.get("deleted"):
                m["text"] = text
                m["edited"] = True
                db_update_message(m)
                broadcast_to_room(room, {"type": "update", "roomId": room["id"], "message": m})
                broadcast_rooms()
                break

    elif action == "pin":
        room = ROOMS.get(data.get("roomId"))
        if not room:
            return
        mid = data.get("messageId")
        room["pinned"] = None if room.get("pinned") == mid else mid
        db_save_room(room)
        broadcast_to_room(room, {"type": "pinned", "roomId": room["id"], "message": find_message(room, room.get("pinned"))})

    elif action == "renameRoom":
        room = ROOMS.get(data.get("roomId"))
        if room and room["type"] == "group":
            room["name"] = (data.get("name") or room["name"])[:30]
            db_save_room(room)
            broadcast_rooms()
            broadcast_to_room(room, {"type": "roomRenamed", "roomId": room["id"], "name": room["name"]})

    elif action == "deleteRoom":
        room = ROOMS.get(data.get("roomId"))
        if not room:
            return
        rid = room["id"]
        ROOMS.pop(rid, None)
        db_delete_room(rid)
        for other in list(CLIENTS.keys()):
            push(other, {"type": "roomDeleted", "roomId": rid})
        broadcast_rooms()

    elif action == "read":
        room = ROOMS.get(data.get("roomId"))
        if room:
            mark_read(cid, room)
            broadcast_read_counts(room)

    elif action == "typing":
        room = ROOMS.get(data.get("roomId"))
        if not room:
            return
        u = USERS.get(cid, {"nickname": "익명"})
        for mid in list(room["members"]):
            if mid != cid:
                push(mid, {"type": "typing", "roomId": room["id"], "nickname": u["nickname"]})


def reaper_loop():
    # 폴링이 끊긴(오프라인) 클라이언트를 감지해 상태를 갱신·전파
    while True:
        time.sleep(8)
        with LOCK:
            changed = False
            for cid, c in list(CLIENTS.items()):
                on = is_online(cid)
                if c.get("_on") and not on:
                    c["_on"] = False
                    if cid in USERS:
                        USERS[cid]["lastSeen"] = now_ms()
                    for room in ROOMS.values():
                        if cid in room["members"]:
                            broadcast_read_counts(room)
                    changed = True
                elif on and not c.get("_on"):
                    c["_on"] = True
                    changed = True
            if changed:
                broadcast_online()
                broadcast_rooms()


# ── HTTP 핸들러 ─────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/poll":
            return self.handle_poll(parse_qs(parsed.query))
        if path == "/config":
            body = json.dumps({"requireCode": bool(ACCESS_CODE)}).encode("utf-8")
            return self._send(200, body, "application/json")

        rel = path.lstrip("/") or "index.html"
        file_path = os.path.normpath(os.path.join(PUBLIC_DIR, rel))
        if not file_path.startswith(PUBLIC_DIR) or not os.path.isfile(file_path):
            return self._send(404, b"404 Not Found")
        try:
            with open(file_path, "rb") as f:
                body = f.read()
        except OSError:
            return self._send(404, b"404 Not Found")
        ext = os.path.splitext(file_path)[1]
        self._send(200, body, MIME.get(ext, "application/octet-stream"))

    def do_POST(self):
        if urlparse(self.path).path != "/api":
            return self._send(404, b"404")
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            return self._send(400, b'{"ok":false}', "application/json")
        with LOCK:
            try:
                result = handle_action(data)
            except Exception as e:
                print("action error:", e)
                result = None
        body = json.dumps(result if isinstance(result, dict) else {"ok": True}, ensure_ascii=False).encode("utf-8")
        self._send(200, body, "application/json")

    def handle_poll(self, qs):
        # 롱폴링: 이벤트가 생기면 즉시, 없으면 POLL_WAIT 후 빈 응답을 "완결된" JSON 으로 반환
        # → 매 응답이 끝나므로 Cloudflare 등 프록시가 버퍼링 없이 통과시킴 (SSE 버퍼링 문제 회피)
        cid = (qs.get("clientId") or [None])[0]
        if not cid:
            return self._send(400, b"clientId required")
        with LOCK:
            c = ensure_client(cid)
            was = is_online(cid)
            c["lastPoll"] = now_ms()
            q = c["q"]
            if cid in USERS and not was:
                c["_on"] = True
                broadcast_online()
                broadcast_rooms()
        events = []
        try:
            events.append(q.get(timeout=POLL_WAIT))
            while True:
                try:
                    events.append(q.get_nowait())
                except queue.Empty:
                    break
        except queue.Empty:
            pass
        body = json.dumps({"events": events}, ensure_ascii=False).encode("utf-8")
        self._send(200, body, "application/json", extra={"Cache-Control": "no-cache, no-transform"})


def main():
    threading.Thread(target=reaper_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print("\n💬 톡톡 메신저 서버 실행 중")
    print(f"   이 PC:        http://localhost:{PORT}")
    print(f"   같은 네트워크: http://<이 PC의 IP>:{PORT}")
    print(f"   대화 저장:     {DB_PATH}")
    print(f"   입장 비밀번호: {'설정됨 (ACCESS_CODE)' if ACCESS_CODE else '없음 (공개)'}")
    print("   종료: Ctrl+C\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n서버 종료")


if __name__ == "__main__":
    main()
