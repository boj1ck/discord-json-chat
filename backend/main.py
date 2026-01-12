import json
import os
import time
import uuid
from typing import Any, Dict, List, Optional, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from passlib.context import CryptContext
from pydantic import BaseModel

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")

USERS_PATH = os.path.join(DATA_DIR, "users.json")
SESSIONS_PATH = os.path.join(DATA_DIR, "sessions.json")
DMS_PATH = os.path.join(DATA_DIR, "dms.json")
MESSAGES_PATH = os.path.join(DATA_DIR, "messages.json")

pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _ensure_files():
    os.makedirs(DATA_DIR, exist_ok=True)
    for p, default in [
        (USERS_PATH, []),
        (SESSIONS_PATH, []),
        (DMS_PATH, []),
        (MESSAGES_PATH, []),
    ]:
        if not os.path.exists(p):
            with open(p, "w", encoding="utf-8") as f:
                json.dump(default, f)


def _read(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write(path: str, data: Any):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _find_user_by_username(users: List[Dict[str, Any]], username: str) -> Optional[Dict[str, Any]]:
    u = username.strip().lower()
    for user in users:
        if user["username"].lower() == u:
            return user
    return None


def _auth_user(token: str) -> Dict[str, Any]:
    sessions = _read(SESSIONS_PATH)
    users = _read(USERS_PATH)
    for s in sessions:
        if s["token"] == token:
            uid = s["user_id"]
            for u in users:
                if u["id"] == uid:
                    return u
    raise HTTPException(status_code=401, detail="Unauthorized")


def _user_public(user: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": user["id"],
        "username": user["username"],
        "friends": user.get("friends", []),
        "avatar": user.get("avatar", None),
    }


def _dm_id_for(a: str, b: str) -> str:
    pair = sorted([a, b])
    dms = _read(DMS_PATH)
    for d in dms:
        if d["type"] == "dm" and d["members"] == pair:
            return d["id"]
    dm_id = str(uuid.uuid4())
    dms.append({
        "id": dm_id,
        "type": "dm",
        "members": pair,
        "created_at": _now_ms()
    })
    _write(DMS_PATH, dms)
    return dm_id


class RegisterBody(BaseModel):
    username: str
    password: str


class LoginBody(BaseModel):
    username: str
    password: str


class AddFriendBody(BaseModel):
    username: str


class SendMessageBody(BaseModel):
    dm_id: str
    content: str


class UpdateUsernameBody(BaseModel):
    username: str


class UpdatePasswordBody(BaseModel):
    old_password: str
    new_password: str


class UpdateAvatarBody(BaseModel):
    avatar_data_url: Optional[str] = None


app = FastAPI(title="Discord JSON Chat")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_ensure_files()


class WSManager:
    def __init__(self):
        self.by_user: Dict[str, Set[WebSocket]] = {}

    async def connect(self, user_id: str, ws: WebSocket):
        await ws.accept()
        self.by_user.setdefault(user_id, set()).add(ws)

    def disconnect(self, user_id: str, ws: WebSocket):
        s = self.by_user.get(user_id)
        if not s:
            return
        if ws in s:
            s.remove(ws)
        if len(s) == 0:
            self.by_user.pop(user_id, None)

    async def emit_user(self, user_id: str, payload: Dict[str, Any]):
        conns = list(self.by_user.get(user_id, set()))
        if not conns:
            return
        dead = []
        for ws in conns:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(user_id, ws)


ws_manager = WSManager()


@app.get("/health")
def health():
    return {"ok": True, "ts": _now_ms()}


@app.get("/users/exists")
def user_exists(username: str):
    users = _read(USERS_PATH)
    return {"exists": _find_user_by_username(users, username) is not None}


@app.post("/register")
def register(body: RegisterBody):
    username = body.username.strip()
    if len(username) < 3 or len(username) > 20:
        raise HTTPException(status_code=400, detail="Username must be 3-20 chars")
    if any(c.isspace() for c in username):
        raise HTTPException(status_code=400, detail="No spaces in username")
    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="Password too short")

    users = _read(USERS_PATH)
    if _find_user_by_username(users, username):
        raise HTTPException(status_code=409, detail="Username already taken")

    user_id = str(uuid.uuid4())
    users.append({
        "id": user_id,
        "username": username,
        "password_hash": pwd.hash(body.password),
        "friends": [],
        "avatar": None,
        "created_at": _now_ms()
    })
    _write(USERS_PATH, users)
    return {"ok": True}


@app.post("/login")
def login(body: LoginBody):
    users = _read(USERS_PATH)
    u = _find_user_by_username(users, body.username)
    if not u:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not pwd.verify(body.password, u["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    sessions = _read(SESSIONS_PATH)
    token = str(uuid.uuid4())
    sessions.append({
        "token": token,
        "user_id": u["id"],
        "created_at": _now_ms()
    })
    _write(SESSIONS_PATH, sessions)
    return {"token": token, "user": _user_public(u)}


@app.get("/me")
def me(authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization.split(" ", 1)[1].strip()
    u = _auth_user(token)
    return {"user": _user_public(u), "token": token}


@app.post("/friends/add")
async def add_friend(body: AddFriendBody, authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization.split(" ", 1)[1].strip()
    me_user = _auth_user(token)

    target_username = body.username.strip()
    users = _read(USERS_PATH)
    target = _find_user_by_username(users, target_username)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target["id"] == me_user["id"]:
        raise HTTPException(status_code=400, detail="Cannot add yourself")

    changed = False
    for u in users:
        if u["id"] == me_user["id"]:
            if target["id"] not in u.get("friends", []):
                u.setdefault("friends", []).append(target["id"])
                changed = True
        if u["id"] == target["id"]:
            if me_user["id"] not in u.get("friends", []):
                u.setdefault("friends", []).append(me_user["id"])
                changed = True

    if changed:
        _write(USERS_PATH, users)

    dm_id = _dm_id_for(me_user["id"], target["id"])

    await ws_manager.emit_user(me_user["id"], {"type": "friends:update"})
    await ws_manager.emit_user(target["id"], {"type": "friends:update"})
    await ws_manager.emit_user(me_user["id"], {"type": "dm:ready", "dm_id": dm_id, "peer_id": target["id"]})
    await ws_manager.emit_user(target["id"], {"type": "dm:ready", "dm_id": dm_id, "peer_id": me_user["id"]})

    return {"ok": True, "dm_id": dm_id}


@app.get("/friends")
def friends(authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization.split(" ", 1)[1].strip()
    me_user = _auth_user(token)

    users = _read(USERS_PATH)
    by_id = {u["id"]: u for u in users}
    out = []
    for fid in me_user.get("friends", []):
        fu = by_id.get(fid)
        if fu:
            out.append(_user_public(fu))
    out.sort(key=lambda x: x["username"].lower())
    return {"friends": out}


@app.get("/dms")
def list_dms(authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization.split(" ", 1)[1].strip()
    me_user = _auth_user(token)

    dms = _read(DMS_PATH)
    users = _read(USERS_PATH)
    by_id = {u["id"]: u for u in users}

    out = []
    for d in dms:
        if d["type"] != "dm":
            continue
        if me_user["id"] not in d["members"]:
            continue
        peer = d["members"][0] if d["members"][1] == me_user["id"] else d["members"][1]
        peer_u = by_id.get(peer)
        out.append({
            "id": d["id"],
            "peer": _user_public(peer_u) if peer_u else {"id": peer, "username": "Unknown", "friends": [], "avatar": None},
            "created_at": d["created_at"]
        })
    out.sort(key=lambda x: x["peer"]["username"].lower())
    return {"dms": out}


@app.get("/messages/{dm_id}")
def get_messages(dm_id: str, authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization.split(" ", 1)[1].strip()
    me_user = _auth_user(token)

    dms = _read(DMS_PATH)
    dm = next((d for d in dms if d["id"] == dm_id and d["type"] == "dm"), None)
    if not dm or me_user["id"] not in dm["members"]:
        raise HTTPException(status_code=404, detail="DM not found")

    msgs = _read(MESSAGES_PATH)
    out = [m for m in msgs if m["dm_id"] == dm_id]
    out.sort(key=lambda x: x["created_at"])
    return {"messages": out}


@app.post("/messages/send")
async def send_message(body: SendMessageBody, authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization.split(" ", 1)[1].strip()
    me_user = _auth_user(token)

    content = body.content.strip()
    if len(content) == 0 or len(content) > 2000:
        raise HTTPException(status_code=400, detail="Invalid message length")

    dms = _read(DMS_PATH)
    dm = next((d for d in dms if d["id"] == body.dm_id and d["type"] == "dm"), None)
    if not dm or me_user["id"] not in dm["members"]:
        raise HTTPException(status_code=404, detail="DM not found")

    msg = {
        "id": str(uuid.uuid4()),
        "dm_id": body.dm_id,
        "author_id": me_user["id"],
        "content": content,
        "created_at": _now_ms()
    }

    msgs = _read(MESSAGES_PATH)
    msgs.append(msg)
    _write(MESSAGES_PATH, msgs)

    a, b = dm["members"][0], dm["members"][1]
    await ws_manager.emit_user(a, {"type": "message:new", "dm_id": body.dm_id, "message": msg})
    await ws_manager.emit_user(b, {"type": "message:new", "dm_id": body.dm_id, "message": msg})

    return {"ok": True, "message": msg}


@app.post("/account/username")
def update_username(body: UpdateUsernameBody, authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization.split(" ", 1)[1].strip()
    me_user = _auth_user(token)

    new_username = body.username.strip()
    if len(new_username) < 3 or len(new_username) > 20:
        raise HTTPException(status_code=400, detail="Username must be 3-20 chars")
    if any(c.isspace() for c in new_username):
        raise HTTPException(status_code=400, detail="No spaces in username")

    users = _read(USERS_PATH)
    existing = _find_user_by_username(users, new_username)
    if existing and existing["id"] != me_user["id"]:
        raise HTTPException(status_code=409, detail="Username already taken")

    for u in users:
        if u["id"] == me_user["id"]:
            u["username"] = new_username
            break

    _write(USERS_PATH, users)
    return {"ok": True}


@app.post("/account/password")
def update_password(body: UpdatePasswordBody, authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization.split(" ", 1)[1].strip()
    me_user = _auth_user(token)

    if len(body.new_password) < 6:
        raise HTTPException(status_code=400, detail="New password too short")

    users = _read(USERS_PATH)
    target = next((u for u in users if u["id"] == me_user["id"]), None)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    if not pwd.verify(body.old_password, target["password_hash"]):
        raise HTTPException(status_code=401, detail="Wrong current password")

    target["password_hash"] = pwd.hash(body.new_password)
    _write(USERS_PATH, users)
    return {"ok": True}


@app.post("/account/avatar")
def update_avatar(body: UpdateAvatarBody, authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization.split(" ", 1)[1].strip()
    me_user = _auth_user(token)

    avatar = body.avatar_data_url
    if avatar is not None:
        if not avatar.startswith("data:image/"):
            raise HTTPException(status_code=400, detail="Invalid avatar")
        if len(avatar) > 2_000_000:
            raise HTTPException(status_code=400, detail="Avatar too large")

    users = _read(USERS_PATH)
    for u in users:
        if u["id"] == me_user["id"]:
            u["avatar"] = avatar
            break

    _write(USERS_PATH, users)
    return {"ok": True}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    token = ws.query_params.get("token", "").strip()
    if not token:
        await ws.close(code=1008)
        return
    try:
        user = _auth_user(token)
    except Exception:
        await ws.close(code=1008)
        return

    user_id = user["id"]
    await ws_manager.connect(user_id, ws)
    try:
        await ws.send_json({"type": "hello", "user": _user_public(user), "ts": _now_ms()})
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(user_id, ws)
    except Exception:
        ws_manager.disconnect(user_id, ws)
