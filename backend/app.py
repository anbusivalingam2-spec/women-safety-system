"""
Women Safety System: back end (Python Flask + SQLite)

Run:   python app.py          then open  http://localhost:5000
The same server also serves the front end from ../frontend, so one command runs everything.

REST API (JSON):
  GET  /api/health
  POST /api/register   {name, phone, password}
  POST /api/login      {phone, password}            -> token
  GET  /api/contacts                                (needs token)
  PUT  /api/contacts   {contacts: [n1, n2, n3]}     (needs token)
  POST /api/sos        {lat, lng, link, trigger}    (needs token)
  GET  /api/users                                   (admin only)
  GET  /api/sos                                     (admin only)
"""
import os
import re
import secrets
import sqlite3
from datetime import datetime, timedelta
from functools import wraps

from flask import Flask, g, jsonify, request, send_from_directory
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(os.path.dirname(BASE_DIR), "frontend")

ADMIN_USER = os.environ.get("WS_ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("WS_ADMIN_PASS", "admin123")
TOKEN_DAYS = 7
PHONE_RE = re.compile(r"^\d{10}$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    phone         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    created       TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    number   TEXT    NOT NULL,
    PRIMARY KEY (user_id, position)
);
CREATE TABLE IF NOT EXISTS sos_alerts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    phone    TEXT NOT NULL,
    trigger  TEXT NOT NULL,
    lat      REAL,
    lng      REAL,
    link     TEXT,
    created  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token   TEXT PRIMARY KEY,
    phone   TEXT NOT NULL,
    name    TEXT NOT NULL,
    role    TEXT NOT NULL,
    expires TEXT NOT NULL
);
"""


def create_app(db_path=None):
    app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
    app.config["DB_PATH"] = db_path or os.environ.get("WS_DB", os.path.join(BASE_DIR, "women_safety.db"))

    # ---------- database ----------
    def get_db():
        if "db" not in g:
            g.db = sqlite3.connect(app.config["DB_PATH"])
            g.db.row_factory = sqlite3.Row
            g.db.execute("PRAGMA foreign_keys = ON")
        return g.db

    @app.teardown_appcontext
    def close_db(_exc):
        db = g.pop("db", None)
        if db is not None:
            db.close()

    with app.app_context():
        get_db().executescript(SCHEMA)
        get_db().commit()

    # ---------- helpers ----------
    def now():
        return datetime.now().isoformat(timespec="seconds")

    def err(message, status):
        return jsonify({"error": message}), status

    def body():
        return request.get_json(silent=True) or {}

    def current_session():
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return None
        token = header[7:].strip()
        row = get_db().execute("SELECT * FROM sessions WHERE token = ?", (token,)).fetchone()
        if row is None:
            return None
        if row["expires"] < now():
            get_db().execute("DELETE FROM sessions WHERE token = ?", (token,))
            get_db().commit()
            return None
        return row

    def login_required(role=None):
        def deco(fn):
            @wraps(fn)
            def wrapper(*args, **kwargs):
                s = current_session()
                if s is None:
                    return err("Please login again.", 401)
                if role and s["role"] != role:
                    return err("Administrator access only.", 403)
                g.session = s
                return fn(*args, **kwargs)
            return wrapper
        return deco

    def new_session(phone, name, role):
        token = secrets.token_hex(24)
        expires = (datetime.now() + timedelta(days=TOKEN_DAYS)).isoformat(timespec="seconds")
        get_db().execute("INSERT INTO sessions (token, phone, name, role, expires) VALUES (?,?,?,?,?)",
                         (token, phone, name, role, expires))
        get_db().commit()
        return token

    # ---------- routes ----------
    @app.get("/")
    def index():
        return send_from_directory(FRONTEND_DIR, "index.html")

    @app.get("/api/health")
    def health():
        return jsonify({"ok": True})

    @app.post("/api/register")
    def register():
        data = body()
        name = str(data.get("name", "")).strip()
        phone = re.sub(r"[\s-]", "", str(data.get("phone", "")))
        password = str(data.get("password", ""))
        if len(name) < 2 or len(name) > 60:
            return err("Enter your full name.", 400)
        if not PHONE_RE.match(phone):
            return err("Phone number must be exactly 10 digits.", 400)
        if len(password) < 6:
            return err("Password needs at least 6 characters.", 400)
        db = get_db()
        if db.execute("SELECT 1 FROM users WHERE phone = ?", (phone,)).fetchone():
            return err("This phone number is already registered.", 409)
        db.execute("INSERT INTO users (name, phone, password_hash, created) VALUES (?,?,?,?)",
                   (name, phone, generate_password_hash(password), now()))
        db.commit()
        return jsonify({"ok": True}), 201

    @app.post("/api/login")
    def login():
        data = body()
        phone = re.sub(r"[\s-]", "", str(data.get("phone", "")))
        password = str(data.get("password", ""))
        if phone.lower() == ADMIN_USER.lower():
            if secrets.compare_digest(password, ADMIN_PASS):
                token = new_session(ADMIN_USER, "Administrator", "admin")
                return jsonify({"ok": True, "token": token,
                                "user": {"name": "Administrator", "phone": ADMIN_USER, "role": "admin"}})
            return err("Wrong phone number or password.", 401)
        row = get_db().execute("SELECT * FROM users WHERE phone = ?", (phone,)).fetchone()
        if row is None or not check_password_hash(row["password_hash"], password):
            return err("Wrong phone number or password.", 401)
        token = new_session(row["phone"], row["name"], "user")
        return jsonify({"ok": True, "token": token,
                        "user": {"name": row["name"], "phone": row["phone"], "role": "user"}})

    def user_id_for(phone):
        row = get_db().execute("SELECT id FROM users WHERE phone = ?", (phone,)).fetchone()
        return row["id"] if row else None

    @app.get("/api/contacts")
    @login_required()
    def get_contacts():
        uid = user_id_for(g.session["phone"])
        slots = ["", "", ""]
        if uid is not None:
            for r in get_db().execute("SELECT position, number FROM contacts WHERE user_id = ?", (uid,)):
                if 0 <= r["position"] < 3:
                    slots[r["position"]] = r["number"]
        return jsonify({"contacts": slots})

    @app.put("/api/contacts")
    @login_required()
    def put_contacts():
        uid = user_id_for(g.session["phone"])
        if uid is None:
            return err("Only registered users can save contacts.", 403)
        raw = body().get("contacts")
        if not isinstance(raw, list) or len(raw) > 3:
            return err("Send up to 3 contact numbers.", 400)
        numbers = [re.sub(r"[\s-]", "", str(n)) for n in raw] + ["", "", ""]
        numbers = numbers[:3]
        if any(n and not PHONE_RE.match(n) for n in numbers):
            return err("Each number must be 10 digits.", 400)
        db = get_db()
        db.execute("DELETE FROM contacts WHERE user_id = ?", (uid,))
        for i, n in enumerate(numbers):
            if n:
                db.execute("INSERT INTO contacts (user_id, position, number) VALUES (?,?,?)", (uid, i, n))
        db.commit()
        return jsonify({"ok": True})

    @app.post("/api/sos")
    @login_required()
    def log_sos():
        data = body()
        trigger = data.get("trigger") if data.get("trigger") in ("button", "shake") else "button"

        def num(v):
            try:
                return float(v)
            except (TypeError, ValueError):
                return None

        lat, lng = num(data.get("lat")), num(data.get("lng"))
        if lat is not None and not -90 <= lat <= 90:
            lat = None
        if lng is not None and not -180 <= lng <= 180:
            lng = None
        link = ""
        if lat is not None and lng is not None:
            link = "https://maps.google.com/?q=%.6f,%.6f" % (lat, lng)   # built on the server, never trusted from the client
        get_db().execute("INSERT INTO sos_alerts (phone, trigger, lat, lng, link, created) VALUES (?,?,?,?,?,?)",
                         (g.session["phone"], trigger, lat, lng, link, now()))
        get_db().commit()
        return jsonify({"ok": True}), 201

    @app.get("/api/users")
    @login_required("admin")
    def list_users():
        rows = get_db().execute("SELECT name, phone, created FROM users ORDER BY id").fetchall()
        return jsonify({"users": [dict(r) for r in rows]})

    @app.get("/api/sos")
    @login_required("admin")
    def list_sos():
        rows = get_db().execute(
            "SELECT created AS time, phone, trigger, lat, lng, link FROM sos_alerts ORDER BY id DESC").fetchall()
        return jsonify({"alerts": [dict(r) for r in rows]})

    @app.errorhandler(404)
    def not_found(_e):
        if request.path.startswith("/api/"):
            return err("Not found.", 404)
        return "Not found", 404

    return app


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    create_app().run(host="0.0.0.0", port=port, debug=False)
