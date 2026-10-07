/* app.js: screens and behaviour for the Women Safety System front end. */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const VIEWS = ["login", "register", "home", "admin"];

  let user = null;
  let pos = null;           // latest GPS fix {lat,lng,acc,t}
  let watchId = null;
  let contacts = ["", "", ""];

  /* ---------- helpers ---------- */
  function toast(msg, kind) {
    const el = $("#toast");
    el.textContent = msg;
    el.dataset.kind = kind || "info";
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, 3200);
  }

  function showErr(id, msg) {
    const el = $(id);
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    kids.forEach(k => node.append(k));
    return node;
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  const cleanPhone = s => String(s || "").replace(/[\s-]/g, "");
  const validPhone = s => /^\d{10}$/.test(s);

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast("Copied"); return; } catch (e) { /* fall through */ }
    const range = document.createRange();
    const box = $("#sosResult .msg-box");
    if (box) { range.selectNodeContents(box); const s = getSelection(); s.removeAllRanges(); s.addRange(range); }
    toast("Press and hold the text to copy");
  }

  /* ---------- navigation ---------- */
  function show(view) {
    VIEWS.forEach(v => { $("#view-" + v).hidden = v !== view; });
    document.body.dataset.view = view;
    $("#btnLogout").hidden = !(view === "home" || view === "admin");
    window.scrollTo(0, 0);
    if (view === "home") enterHome(); else stopWatch();
    if (view === "admin") loadAdmin();
  }

  document.addEventListener("click", e => {
    const a = e.target.closest("[data-go]");
    if (a) { e.preventDefault(); showErr("#loginErr"); showErr("#regErr"); show(a.dataset.go); }
  });

  function setModebar() {
    const bar = $("#modebar");
    bar.dataset.mode = Api.mode;
    bar.textContent = Api.mode === "server"
      ? "Connected to the server"
      : "Demo mode: no server found, data stays in this browser";
  }

  /* ---------- login / register ---------- */
  $("#formLogin").addEventListener("submit", async e => {
    e.preventDefault();
    const phone = cleanPhone($("#loginUser").value);
    const pass = $("#loginPass").value;
    if (!phone || !pass) return showErr("#loginErr", "Enter your phone number and password.");
    showErr("#loginErr");
    const r = await Api.login(phone, pass);
    if (!r.ok) return showErr("#loginErr", r.error || "Login failed.");
    user = r.user;
    $("#loginPass").value = "";
    show(user.role === "admin" ? "admin" : "home");
  });

  $("#formRegister").addEventListener("submit", async e => {
    e.preventDefault();
    const name = $("#regName").value.trim();
    const phone = cleanPhone($("#regPhone").value);
    const password = $("#regPass").value;
    if (name.length < 2) return showErr("#regErr", "Enter your full name.");
    if (!validPhone(phone)) return showErr("#regErr", "Phone number must be exactly 10 digits.");
    if (password.length < 6) return showErr("#regErr", "Password needs at least 6 characters.");
    showErr("#regErr");
    const r = await Api.register({ name, phone, password });
    if (!r.ok) return showErr("#regErr", r.error || "Registration failed.");
    e.target.reset();
    $("#loginUser").value = phone;
    show("login");
    toast("Registered. Please login.");
  });

  $("#btnLogout").addEventListener("click", () => {
    stopSiren(); stopShake(); endCall(true);
    Api.logout();
    user = null;
    $("#sosResult").hidden = true;
    show("login");
  });

  /* ---------- home: location ---------- */
  function setLoc(state, title, text) {
    const card = $("#locCard");
    card.dataset.state = state;
    $("#locTitle").textContent = title;
    $("#locText").textContent = text;
  }

  function geoMessage(err) {
    if (err && err.code === 1) return "Location permission is blocked. Allow location for this site in the browser settings, then reload.";
    if (err && err.code === 3) return "Location is taking too long. Move near a window or open sky and try again.";
    return "Location is not available on this device right now. Turn on GPS and try again.";
  }

  function startWatch() {
    if (watchId !== null) return;
    if (!("geolocation" in navigator)) return setLoc("error", "No location support", "This browser cannot read GPS.");
    setLoc("wait", "Finding your location", "Allow location access when the browser asks.");
    watchId = navigator.geolocation.watchPosition(p => {
      pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() };
      setLoc("ok", "Location ready", pos.lat.toFixed(5) + ", " + pos.lng.toFixed(5) + "  (accuracy about " + Math.round(pos.acc) + " m)");
    }, err => {
      setLoc("error", "Location not found", geoMessage(err));
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }

  function stopWatch() {
    if (watchId !== null && "geolocation" in navigator) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  function getFix() {
    return new Promise(resolve => {
      if (pos && Date.now() - pos.t < 60000) return resolve(pos);
      if (!("geolocation" in navigator)) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        p => { pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() }; resolve(pos); },
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
      );
    });
  }

  /* ---------- home: contacts ---------- */
  function readContactInputs() {
    return [1, 2, 3].map(n => cleanPhone($("#c" + n).value));
  }

  async function enterHome() {
    $("#helloName").textContent = "Hello, " + (user && user.name ? user.name : "");
    startWatch();
    const r = await Api.getContacts();
    contacts = (r.contacts || ["", "", ""]).concat(["", "", ""]).slice(0, 3);
    contacts.forEach((c, i) => { $("#c" + (i + 1)).value = c; });
    refreshCallLink();
  }

  $("#formContacts").addEventListener("submit", async e => {
    e.preventDefault();
    const list = readContactInputs();
    if (list.some(n => n && !validPhone(n))) return toast("Each number must be 10 digits.", "error");
    if (!list.some(Boolean)) return toast("Enter at least one number.", "error");
    const r = await Api.saveContacts(list);
    if (!r.ok) return toast(r.error || "Could not save.", "error");
    contacts = list;
    refreshCallLink();
    toast("Numbers saved");
  });

  function refreshCallLink() {
    const first = contacts.find(Boolean);
    const a = $("#btnCall");
    a.href = first ? "tel:" + first : "#";
  }

  $("#btnCall").addEventListener("click", e => {
    if (!contacts.find(Boolean)) { e.preventDefault(); toast("Save a contact number first.", "error"); }
  });

  /* ---------- home: SOS ---------- */
  async function sendSOS(trigger) {
    const saved = contacts.filter(Boolean);
    if (!saved.length) { toast("Save at least one contact first.", "error"); return; }
    const btn = $("#btnSOS");
    btn.setAttribute("aria-busy", "true");
    const fix = await getFix();
    btn.removeAttribute("aria-busy");

    const link = fix ? Api.linkFor(fix.lat, fix.lng) : "";
    const message = fix
      ? "I need help! My location: " + link
      : "I need help! My location could not be found, please call me.";

    Api.logSos({ lat: fix ? fix.lat : null, lng: fix ? fix.lng : null, link, trigger });
    renderSosResult(message, saved, !!fix);
  }

  function renderSosResult(message, numbers, hasFix) {
    const box = $("#sosResult");
    box.replaceChildren();
    box.append(el("h2", { textContent: "SOS ready" }));
    box.append(el("p", { className: "muted", textContent: hasFix ? "Your location is in the message below." : "No GPS fix yet, so the message has no map link." }));
    box.append(el("div", { className: "msg-box", textContent: message }));

    const actions = el("div", { className: "result-actions" });
    numbers.forEach(n => {
      actions.append(el("a", { className: "btn btn-primary", href: "sms:" + n + "?body=" + encodeURIComponent(message), textContent: "Open SMS to " + n }));
    });
    actions.append(el("button", { className: "btn btn-dark", type: "button", textContent: "Copy message", onclick: () => copyText(message) }));
    box.append(actions);
    box.append(el("p", { className: "note", textContent: "A web page cannot send SMS silently. The buttons open your messaging app with the message filled in; press send there. The alert is also saved for the administrator." }));
    box.hidden = false;
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  $("#btnSOS").addEventListener("click", () => sendSOS("button"));

  /* ---------- home: siren ---------- */
  let audioCtx = null, sirenOsc = null, sirenGain = null, sirenTimer = null;

  function ctx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function startSiren() {
    if (sirenOsc) return;
    const c = ctx();
    sirenOsc = c.createOscillator();
    sirenGain = c.createGain();
    sirenOsc.type = "sawtooth";
    sirenGain.gain.value = 0.35;
    sirenOsc.connect(sirenGain).connect(c.destination);
    sirenOsc.start();
    let up = true;
    const sweep = () => {
      const now = c.currentTime;
      sirenOsc.frequency.cancelScheduledValues(now);
      sirenOsc.frequency.setValueAtTime(up ? 650 : 1250, now);
      sirenOsc.frequency.linearRampToValueAtTime(up ? 1250 : 650, now + 0.6);
      up = !up;
    };
    sweep();
    sirenTimer = setInterval(sweep, 600);
    $("#btnSiren").disabled = true;
    $("#btnStopSiren").disabled = false;
  }

  function stopSiren() {
    clearInterval(sirenTimer);
    if (sirenOsc) { try { sirenOsc.stop(); } catch (e) { /* already stopped */ } sirenOsc.disconnect(); }
    sirenOsc = null;
    $("#btnSiren").disabled = false;
    $("#btnStopSiren").disabled = true;
  }

  $("#btnSiren").addEventListener("click", startSiren);
  $("#btnStopSiren").addEventListener("click", stopSiren);

  /* ---------- home: fake call ---------- */
  let ringTimer = null, callTimer = null, callWait = null, callSecs = 0;

  function ring() {
    const c = ctx();
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = 440;
    g.gain.setValueAtTime(0.2, c.currentTime);
    g.gain.setValueAtTime(0, c.currentTime + 0.4);
    o.connect(g).connect(c.destination);
    o.start();
    o.stop(c.currentTime + 0.45);
    try { navigator.vibrate && navigator.vibrate(300); } catch (e) { /* not supported */ }
  }

  $("#btnFake").addEventListener("click", () => {
    ctx();                                   // unlock audio on this tap
    toast("Fake call in 5 seconds");
    clearTimeout(callWait);
    callWait = setTimeout(() => {
      $("#callState").textContent = "Incoming call";
      $("#callTimer").hidden = true;
      $("#callOverlay").classList.remove("active");
      $("#callOverlay").hidden = false;
      ring();
      ringTimer = setInterval(ring, 1200);
    }, 5000);
  });

  function endCall(silent) {
    clearTimeout(callWait);
    clearInterval(ringTimer);
    clearInterval(callTimer);
    $("#callOverlay").hidden = true;
    $("#callOverlay").classList.remove("active");
    if (!silent) toast("Call ended");
  }

  $("#callAccept").addEventListener("click", () => {
    clearInterval(ringTimer);
    callSecs = 0;
    $("#callState").textContent = "On call";
    $("#callTimer").hidden = false;
    $("#callTimer").textContent = "00:00";
    $("#callOverlay").classList.add("active");
    $("#callDecline").textContent = "End call";
    callTimer = setInterval(() => {
      callSecs += 1;
      const m = String(Math.floor(callSecs / 60)).padStart(2, "0");
      const s = String(callSecs % 60).padStart(2, "0");
      $("#callTimer").textContent = m + ":" + s;
    }, 1000);
  });
  $("#callDecline").addEventListener("click", () => { $("#callDecline").textContent = "Decline"; endCall(); });

  /* ---------- home: shake to SOS ---------- */
  let lastShake = 0;
  function onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a) return;
    const mag = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
    if (mag > 28 && Date.now() - lastShake > 8000) {
      lastShake = Date.now();
      toast("Shake detected");
      sendSOS("shake");
    }
  }
  function stopShake() {
    window.removeEventListener("devicemotion", onMotion);
    $("#shakeToggle").checked = false;
  }
  $("#shakeToggle").addEventListener("change", async e => {
    if (!e.target.checked) return stopShake();
    if (!("DeviceMotionEvent" in window)) { stopShake(); return toast("This device has no motion sensor.", "error"); }
    try {
      if (typeof DeviceMotionEvent.requestPermission === "function") {
        const r = await DeviceMotionEvent.requestPermission();
        if (r !== "granted") { stopShake(); return toast("Motion permission denied.", "error"); }
      }
    } catch (err) { stopShake(); return toast("Motion permission not available.", "error"); }
    window.addEventListener("devicemotion", onMotion);
    toast("Shake to SOS is on");
  });

  /* ---------- admin ---------- */
  let allUsers = [];

  function renderUsers() {
    const q = $("#userSearch").value.trim().toLowerCase();
    const rows = allUsers.filter(u => !q || u.name.toLowerCase().includes(q) || u.phone.includes(q));
    const body = $("#usersBody");
    body.replaceChildren();
    if (!rows.length) {
      body.append(el("tr", {}, el("td", { colSpan: 4, className: "empty", textContent: allUsers.length ? "No user matches your search." : "No users yet. Press Load users." })));
      return;
    }
    rows.forEach((u, i) => {
      const nameCell = el("td", { textContent: u.name });
      if (u.sample) nameCell.append(el("span", { className: "tag", textContent: "sample" }));
      body.append(el("tr", {}, el("td", { textContent: String(i + 1) }), nameCell, el("td", { textContent: u.phone }), el("td", { textContent: fmtDate(u.created) })));
    });
  }

  async function loadAdmin() {
    const [u, s] = await Promise.all([Api.users(), Api.sos()]);
    if (u.error || s.error) toast(u.error || s.error, "error");
    allUsers = u.users || [];
    const alerts = s.alerts || [];
    $("#statUsers").textContent = allUsers.length;
    $("#statSos").textContent = alerts.length;
    renderUsers();

    const body = $("#sosBody");
    body.replaceChildren();
    if (!alerts.length) {
      body.append(el("tr", {}, el("td", { colSpan: 4, className: "empty", textContent: "No SOS alerts yet." })));
      return;
    }
    alerts.forEach(a => {
      const where = a.link
        ? el("a", { href: a.link, target: "_blank", rel: "noopener", textContent: Number(a.lat).toFixed(4) + ", " + Number(a.lng).toFixed(4) })
        : el("span", { className: "muted", textContent: "not found" });
      const who = el("td", { textContent: a.phone });
      if (a.sample) who.append(el("span", { className: "tag", textContent: "sample" }));
      body.append(el("tr", {}, el("td", { textContent: fmtDate(a.time) }), who, el("td", { textContent: a.trigger }), el("td", {}, where)));
    });
  }

  $("#btnLoad").addEventListener("click", async () => { await loadAdmin(); toast("List updated"); });
  $("#userSearch").addEventListener("input", renderUsers);

  /* ---------- start ---------- */
  (async function boot() {
    await Api.init();
    setModebar();
    const s = Api.session();
    if (s && s.user) {
      Api.restore(s);
      user = s.user;
      show(user.role === "admin" ? "admin" : "home");
    } else {
      show("login");
    }
  })();
})();
