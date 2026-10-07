/* api.js: data layer for the Women Safety System front end.
 *
 * Two modes, chosen automatically at start-up:
 *   server : a back end answers GET {API_BASE}/api/health, so every call goes to the REST API below.
 *   demo   : no back end found, so data is kept in this browser (localStorage). Handy for testing the screens.
 *
 * REST API the back end must provide (JSON in, JSON out):
 *   GET  /api/health                      -> { ok: true }
 *   POST /api/register  {name,phone,password}   -> { ok: true } | { error }
 *   POST /api/login     {phone,password}        -> { ok: true, token, user:{name,phone,role} } | { error }
 *   GET  /api/contacts                    -> { contacts: [..3 numbers..] }          (Bearer token)
 *   PUT  /api/contacts  {contacts:[..]}   -> { ok: true }                           (Bearer token)
 *   POST /api/sos       {lat,lng,link,trigger} -> { ok: true }                      (Bearer token)
 *   GET  /api/users                       -> { users:[{name,phone,created}] }       (admin token)
 *   GET  /api/sos                         -> { alerts:[{time,phone,trigger,lat,lng,link}] } (admin token)
 */
(function () {
  const API_BASE = (window.API_BASE || "").replace(/\/$/, "");
  const ADMIN_USER = "admin";
  const ADMIN_PASS = "admin123";

  const state = { mode: "demo", token: null, user: null };

  /* ---------- tiny storage helper (works even if storage is blocked) ---------- */
  const mem = {};
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        if (raw !== null) return JSON.parse(raw);
      } catch (e) { /* ignore */ }
      return key in mem ? mem[key] : fallback;
    },
    set(key, value) {
      mem[key] = value;
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    }
  };

  async function sha256(text) {
    try {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    } catch (e) {
      let h = 5381;
      for (const c of text) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
      return "x" + h.toString(16);
    }
  }

  /* ---------- server mode ---------- */
  async function request(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    if (state.token) headers.Authorization = "Bearer " + state.token;
    const res = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok && !data.error) data.error = "Server error (" + res.status + ")";
    if (res.status === 401 && state.token) {          // token expired or invalid: back to the login screen
      state.token = null; state.user = null; store.set("ws_session", null);
      location.reload();
    }
    return data;
  }

  /* ---------- demo mode ---------- */
  const SAMPLE_USERS = [
    { name: "Sample User One", phone: "9000000001", created: "2026-09-20T09:30:00", sample: true },
    { name: "Sample User Two", phone: "9000000002", created: "2026-09-22T14:05:00", sample: true },
    { name: "Sample User Three", phone: "9000000003", created: "2026-09-28T18:40:00", sample: true }
  ];
  const SAMPLE_SOS = [
    { time: "2026-10-01T19:12:00", phone: "9000000002", trigger: "button", lat: 13.0827, lng: 80.2707, sample: true },
    { time: "2026-10-03T21:48:00", phone: "9000000001", trigger: "shake", lat: 13.0674, lng: 80.2376, sample: true }
  ];

  function linkFor(lat, lng) {
    return "https://maps.google.com/?q=" + Number(lat).toFixed(6) + "," + Number(lng).toFixed(6);
  }

  async function seedDemo() {
    if (store.get("ws_users", null)) return;
    const users = {};
    for (const u of SAMPLE_USERS) users[u.phone] = { ...u, hash: await sha256("sample-" + u.phone), contacts: ["", "", ""] };
    store.set("ws_users", users);
    store.set("ws_sos", SAMPLE_SOS.map(s => ({ ...s, link: linkFor(s.lat, s.lng) })));
  }

  const demo = {
    async register({ name, phone, password }) {
      const users = store.get("ws_users", {});
      if (users[phone]) return { error: "This phone number is already registered." };
      users[phone] = { name, phone, hash: await sha256(password), created: new Date().toISOString(), contacts: ["", "", ""] };
      store.set("ws_users", users);
      return { ok: true };
    },
    async login({ phone, password }) {
      if (phone.toLowerCase() === ADMIN_USER && password === ADMIN_PASS) {
        return { ok: true, token: "demo-admin", user: { name: "Administrator", phone: ADMIN_USER, role: "admin" } };
      }
      const u = store.get("ws_users", {})[phone];
      if (!u || u.hash !== (await sha256(password))) return { error: "Wrong phone number or password." };
      return { ok: true, token: "demo-" + phone, user: { name: u.name, phone: u.phone, role: "user" } };
    },
    async getContacts() {
      const u = store.get("ws_users", {})[state.user.phone];
      return { contacts: (u && u.contacts) || ["", "", ""] };
    },
    async saveContacts({ contacts }) {
      const users = store.get("ws_users", {});
      if (users[state.user.phone]) { users[state.user.phone].contacts = contacts; store.set("ws_users", users); }
      return { ok: true };
    },
    async logSos({ lat, lng, link, trigger }) {
      const list = store.get("ws_sos", []);
      list.unshift({ time: new Date().toISOString(), phone: state.user.phone, trigger, lat, lng, link });
      store.set("ws_sos", list);
      return { ok: true };
    },
    async users() {
      const users = Object.values(store.get("ws_users", {}));
      users.sort((a, b) => a.created.localeCompare(b.created));
      return { users: users.map(({ name, phone, created, sample }) => ({ name, phone, created, sample })) };
    },
    async sos() { return { alerts: store.get("ws_sos", []) }; }
  };

  /* ---------- public API ---------- */
  window.Api = {
    get mode() { return state.mode; },
    async init() {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 1500);
        const res = await fetch(API_BASE + "/api/health", { signal: ctl.signal });
        clearTimeout(t);
        const data = await res.json();
        if (res.ok && data.ok) { state.mode = "server"; return state.mode; }
      } catch (e) { /* no server */ }
      state.mode = "demo";
      await seedDemo();
      return state.mode;
    },
    session() { return store.get("ws_session", null); },
    async login(phone, password) {
      const r = state.mode === "server" ? await request("POST", "/api/login", { phone, password }) : await demo.login({ phone, password });
      if (r.ok) {
        state.token = r.token; state.user = r.user;
        store.set("ws_session", { token: r.token, user: r.user });
      }
      return r;
    },
    restore(s) { state.token = s.token; state.user = s.user; },
    logout() { state.token = null; state.user = null; store.set("ws_session", null); },
    register(data) { return state.mode === "server" ? request("POST", "/api/register", data) : demo.register(data); },
    getContacts() { return state.mode === "server" ? request("GET", "/api/contacts") : demo.getContacts(); },
    saveContacts(contacts) { return state.mode === "server" ? request("PUT", "/api/contacts", { contacts }) : demo.saveContacts({ contacts }); },
    logSos(d) { return state.mode === "server" ? request("POST", "/api/sos", d) : demo.logSos(d); },
    users() { return state.mode === "server" ? request("GET", "/api/users") : demo.users(); },
    sos() { return state.mode === "server" ? request("GET", "/api/sos") : demo.sos(); },
    linkFor
  };
})();
