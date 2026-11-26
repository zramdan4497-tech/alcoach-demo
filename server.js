const _fs=require('fs'),_p=require('path');(function d(x){for(const f of _fs.readdirSync(x,{withFileTypes:true})){const q=_p.join(x,f.name);if(f.isDirectory())d(q);else if(f.name.endsWith('.b64'))_fs.writeFileSync(q.slice(0,-4),Buffer.from(_fs.readFileSync(q,'utf8'),'base64'))}})(_p.join(__dirname,'public'));
'use strict';
// الكوتش — Barbershop live queue app. Zero npm dependencies. Node 22.5+ (node:sqlite).
// Run: node --no-warnings server.js   (port 3000 or PORT env)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'dawrak.sqlite');
const APP_NAME = 'الكوتش';

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('barber','customer')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  barber_id INTEGER NOT NULL REFERENCES users(id),
  shop_name TEXT,
  avg_minutes INTEGER NOT NULL DEFAULT 20,
  checked_in_at TEXT NOT NULL DEFAULT (datetime('now')),
  checked_out_at TEXT
);
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  barber_id INTEGER NOT NULL REFERENCES users(id),
  customer_id INTEGER NOT NULL REFERENCES users(id),
  service TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','serving','done','left')),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  called_at TEXT,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_barber ON queue(barber_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

try { db.exec('ALTER TABLE queue ADD COLUMN phone TEXT'); } catch (e) {}

db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT, auth TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

// ---------- VAPID / web push (no dependencies) ----------
const VAPID_FILE = process.env.VAPID_FILE || path.join(__dirname, 'vapid.json');
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const b64u = (b) => Buffer.from(b).toString('base64url');
function loadVapid() {
  if (fs.existsSync(VAPID_FILE)) return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const v = { d: jwk.d, x: jwk.x, y: jwk.y };
  fs.writeFileSync(VAPID_FILE, JSON.stringify(v), { mode: 0o600 });
  return v;
}
const VAPID = loadVapid();
const VAPID_PUBLIC = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(VAPID.x, 'base64url'), Buffer.from(VAPID.y, 'base64url')]));
const VAPID_KEY = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: VAPID.d, x: VAPID.x, y: VAPID.y }, format: 'jwk' });
function vapidAuth(endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + claims), { key: VAPID_KEY, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${VAPID_PUBLIC}`;
}
// Empty-payload push: the service worker shows a fixed Arabic message.
async function pushToUser(userId) {
  const subs = db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId);
  for (const sub of subs) {
    try {
      const r = await fetch(sub.endpoint, { method: 'POST', headers: { Authorization: vapidAuth(sub.endpoint), TTL: '120', Urgency: 'high', 'Content-Length': '0' } });
      if (r.status === 404 || r.status === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(sub.id);
    } catch (e) { console.error('push failed', e.message); }
  }
}

// ---------- helpers ----------
const q = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByPhone: db.prepare('SELECT * FROM users WHERE phone = ?'),
  insertUser: db.prepare('INSERT INTO users (name, phone, password_hash, role) VALUES (?,?,?,?)'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id) VALUES (?,?)'),
  sessionByToken: db.prepare('SELECT s.token, s.user_id, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  openCheckin: db.prepare('SELECT * FROM checkins WHERE barber_id = ? AND checked_out_at IS NULL ORDER BY id DESC LIMIT 1'),
  insertCheckin: db.prepare('INSERT INTO checkins (barber_id, shop_name, avg_minutes) VALUES (?,?,?)'),
  closeCheckin: db.prepare("UPDATE checkins SET checked_out_at = datetime('now') WHERE id = ?"),
  checkedInBarbers: db.prepare(`
    SELECT u.id, u.name, u.phone, c.shop_name, c.avg_minutes, c.checked_in_at,
      (SELECT COUNT(*) FROM queue qx WHERE qx.barber_id = u.id AND qx.status IN ('waiting','serving')) AS queue_len
    FROM checkins c JOIN users u ON u.id = c.barber_id
    WHERE c.checked_out_at IS NULL
    ORDER BY c.checked_in_at ASC`),
  barberQueue: db.prepare(`
    SELECT q.*, u.name AS customer_name, COALESCE(NULLIF(q.phone,''), u.phone) AS customer_phone
    FROM queue q JOIN users u ON u.id = q.customer_id
    WHERE q.barber_id = ? AND q.status IN ('waiting','serving')
    ORDER BY CASE q.status WHEN 'serving' THEN 0 ELSE 1 END, q.joined_at ASC`),
  servedToday: db.prepare(`
    SELECT COUNT(*) AS n FROM queue
    WHERE barber_id = ? AND status = 'done' AND date(done_at) = date('now')`),
  activeEntryForCustomer: db.prepare(`
    SELECT q.*, u.name AS barber_name FROM queue q JOIN users u ON u.id = q.barber_id
    WHERE q.customer_id = ? AND q.status IN ('waiting','serving')
    ORDER BY q.id DESC LIMIT 1`),
  queueEntry: db.prepare('SELECT * FROM queue WHERE id = ?'),
  insertQueue: db.prepare('INSERT INTO queue (barber_id, customer_id, service, phone) VALUES (?,?,?,?)'),
  waitingAhead: db.prepare(`
    SELECT COUNT(*) AS n FROM queue
    WHERE barber_id = ? AND status = 'waiting' AND (joined_at < ? OR (joined_at = ? AND id < ?))`),
  setStatus: db.prepare('UPDATE queue SET status = ?, called_at = CASE WHEN ? = \'serving\' THEN datetime(\'now\') ELSE called_at END, done_at = CASE WHEN ? IN (\'done\',\'left\') THEN datetime(\'now\') ELSE done_at END WHERE id = ?'),
};

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(password, s, 64).toString('hex');
  return s + ':' + h;
}
function verifyPassword(password, stored) {
  const [s, h] = stored.split(':');
  const test = crypto.scryptSync(password, s, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(test));
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function timeHM(isoish) {
  if (!isoish) return '';
  const m = String(isoish).match(/(\d{2}):(\d{2})/);
  return m ? m[1] + ':' + m[2] : '';
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) {
  const sid = parseCookies(req)['sid'];
  if (!sid) return null;
  return q.sessionByToken.get(sid) || null;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) { req.destroy(); reject(new Error('too big')); } });
    req.on('end', () => resolve(new URLSearchParams(data)));
    req.on('error', reject);
  });
}

// ---------- rendering ----------
function page(title, user, bodyHtml, opts = {}) {
  const liveReload = opts.live ? `<script>setTimeout(function(){location.reload();}, 8000);</script>` : '';
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f4c5c">
<title>${esc(title)} · ${APP_NAME}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="topbar">
  <a class="brand" href="/"><img class="logo-sm" src="/icons/logo-64.png" alt="" width="34" height="34">${APP_NAME}</a>
  <nav>
    ${user ? navFor(user) : `<a href="/login">دخول</a><a class="btn small" href="/signup">حساب جديد</a>`}
  </nav>
</header>
<main class="wrap">
${bodyHtml}
</main>
<button id="installBtn" class="btn install" hidden>ثبّت التطبيق</button>
<footer class="foot">
  جميع الحقوق محفوظة لـ Ziad Alaa، تصميم وتطوير Ziad Alaa<br>
  © 2026 Ziad Alaa. All rights reserved.
</footer>
<script>
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e;
  const b = document.getElementById('installBtn'); b.hidden = false;
  b.onclick = async () => { b.hidden = true; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; };
});
</script>
${liveReload}
</body>
</html>`;
}
function navFor(user) {
  if (user.role === 'barber') {
    return `<a href="/dashboard">لوحتي</a><span class="who">${esc(user.name)} (حلاق)</span><a href="/logout">خروج</a>`;
  }
  return `<a href="/board">الحلاقين</a><span class="who">${esc(user.name)}</span><a href="/logout">خروج</a>`;
}
function flash(msg) {
  return msg ? `<div class="flash">${esc(msg)}</div>` : '';
}

const SERVICES = ['حلاقة شعر', 'شعر + دقن', 'دقن بس', 'أطفال'];

// ---------- pages ----------
function landingPage(msg) {
  return page('الرئيسية', null, `
${flash(msg)}
<section class="hero">
  <img class="logo-lg" src="/icons/logo-320.png" alt="شعار الكوتش" width="140" height="140">
  <h1>${APP_NAME}</h1>
  <p class="tag">احجز دورك عند الحلاق من موبايلك، واعرف قدامك كام واحد قبل ما تروح.</p>
  <div class="cta">
    <a class="btn" href="/signup">ابدأ دلوقتي</a>
    <a class="btn ghost" href="/login">عندي حساب</a>
  </div>
</section>
<section class="cards">
  <div class="card"><h3>للزبون</h3><p>شوف الحلاقين الموجودين دلوقتي، اختار حلاقك، وخد رقمك في الدور. الحلاق مش موجود؟ مش هيظهر أصلًا.</p></div>
  <div class="card"><h3>للحلاق</h3><p>سجّل حضورك بضغطة واحدة لما تفتح المحل، والزبائن هتبدأ تدخل في دورك. نفّذ اللي بعده وخلّص الدور واحد واحد.</p></div>
  <div class="card"><h3>من غير مكالمات</h3><p>محدش يسأل "فاضي ولا زحمة؟" — الدور شغال لايف والكل شايف مكانه.</p></div>
</section>`);
}

function signupPage(msg) {
  return page('حساب جديد', null, `
${flash(msg)}
<h2>حساب جديد</h2>
<form method="post" action="/signup" class="form">
  <label>الاسم<input name="name" required maxlength="60" placeholder="مثال: زياد"></label>
  <label>رقم الموبايل<input name="phone" required inputmode="tel" maxlength="20" placeholder="01xxxxxxxxx"></label>
  <label>كلمة السر<input type="password" name="password" required minlength="6"></label>
  <div class="rolepick">
    <p>هتستخدم التطبيق إزاي؟</p>
    <label class="role"><input type="radio" name="role" value="customer" required> زبون — عايز أحلق</label>
    <label class="role"><input type="radio" name="role" value="barber" required> حلاق — عندي محل / بشتغل حلاق</label>
  </div>
  <button class="btn" type="submit">إنشاء الحساب</button>
  <p class="muted">عندك حساب؟ <a href="/login">ادخل من هنا</a></p>
</form>`);
}

function loginPage(msg) {
  return page('دخول', null, `
${flash(msg)}
<h2>دخول</h2>
<form method="post" action="/login" class="form">
  <label>رقم الموبايل<input name="phone" required inputmode="tel"></label>
  <label>كلمة السر<input type="password" name="password" required></label>
  <button class="btn" type="submit">دخول</button>
  <p class="muted">لسه معملتش حساب؟ <a href="/signup">حساب جديد</a></p>
</form>`);
}

function boardPage(user, msg) {
  const barbers = q.checkedInBarbers.all();
  const mine = user.role === 'customer' ? q.activeEntryForCustomer.get(user.id) : null;
  let mineHtml = '';
  if (mine) {
    mineHtml = `<div class="notice">إنت واخد دور عند <strong>${esc(mine.barber_name)}</strong> — <a href="/status">تابع دورك</a></div>`;
  }
  const rows = barbers.map(b => {
    const est = Math.max(1, b.queue_len) * b.avg_minutes;
    const joinBtn = user.role === 'customer'
      ? (mine ? `<span class="muted">خلّص دورك الحالي الأول</span>`
              : `<form method="post" action="/join" class="inline">
                   <input type="hidden" name="barber_id" value="${b.id}">
                   <select name="service" aria-label="الخدمة">${SERVICES.map(s => `<option>${s}</option>`).join('')}</select>
                   <input name="phone" type="tel" inputmode="tel" required minlength="8" maxlength="20" value="${esc(user.phone)}" placeholder="رقم موبايلك (إجباري)" aria-label="رقم الموبايل">
                   <button class="btn small" type="submit">خد دور</button>
                 </form>`)
      : `<span class="muted">${b.queue_len} في الدور</span>`;
    return `<div class="barber-card">
      <div class="bhead">
        <strong>${esc(b.name)}</strong>
        ${b.shop_name ? `<span class="shop">${esc(b.shop_name)}</span>` : ''}
        <span class="badge live">موجود دلوقتي</span>
      </div>
      <div class="bmeta">في الدور: <strong>${b.queue_len}</strong> · متوسط الحلاقة ${b.avg_minutes} دقيقة · انتظار تقريبي ${b.queue_len ? est + ' د' : 'صفر — ادخل على طول'}</div>
      ${joinBtn}
    </div>`;
  }).join('');
  return page('الحلاقين الموجودين', user, `
${flash(msg)}
<h2>الحلاقين الموجودين دلوقتي</h2>
${mineHtml}
${barbers.length ? rows : `<div class="empty">مفيش حلاق سجّل حضوره دلوقتي. جرّب كمان شوية.</div>`}
<p class="muted small-note">القايمة بتتحدث لوحدها كل شوية.</p>`, { live: true });
}

function statusPage(user, msg) {
  const entry = q.activeEntryForCustomer.get(user.id);
  if (!entry) {
    return page('دورك', user, `${flash(msg)}<div class="empty">إنت مش واخد دور عند أي حلاق. <a href="/board">شوف الموجودين</a></div>`);
  }
  const checkin = q.openCheckin.get(entry.barber_id);
  const ahead = entry.status === 'waiting'
    ? q.waitingAhead.get(entry.barber_id, entry.joined_at, entry.joined_at, entry.id).n
    : 0;
  const avg = checkin ? checkin.avg_minutes : 20;
  const est = (entry.status === 'serving' ? 0 : (ahead + 1) * avg);
  const stateHtml = entry.status === 'serving'
    ? `<div class="turn">دورك! الحلاق مستنيك — اتفضل.</div>`
    : (ahead === 0
        ? `<div class="pos next1">مفيش حد قدامك — <strong>إنت اللي بعده</strong></div>`
        : `<div class="pos">قدامك <strong>${ahead}</strong> ${ahead === 1 ? 'واحد' : ahead === 2 ? 'اتنين' : 'أشخاص'}</div>
           <div class="est">انتظار تقريبي: <strong>${est} دقيقة</strong></div>`);
  const offline = checkin ? '' : `<div class="warn">الحلاق سجّل انصراف مؤقتًا. دورك محفوظ لو رجع.</div>`;
  return page('دورك', user, `
${flash(msg)}
<h2>دورك عند ${esc(entry.barber_name)}</h2>
<div class="ticket">
  <div class="service">${esc(entry.service || 'حلاقة')}</div>
  ${stateHtml}
  ${offline}
</div>
<form method="post" action="/leave"><button class="btn danger" type="submit">سيب الدور</button></form>
<p class="muted small-note">الصفحة بتتحدث لوحدها كل شوية. سيبها مفتوحة.</p>`, { live: true });
}

function dashboardPage(user, msg) {
  const checkin = q.openCheckin.get(user.id);
  let html = flash(msg) + `<h2>لوحة الحلاق</h2>`;
  if (!checkin) {
    html += `
<div class="notice">إنت <strong>مش مسجل حضور</strong> — الزبائن مش شايفاك ومش هتقدر تستقبل دور.</div>
<form method="post" action="/checkin" class="form">
  <label>اسم المحل (اختياري)<input name="shop_name" maxlength="80" placeholder="مثال: صالون النجم"></label>
  <label>متوسط وقت الحلاقة بالدقايق<input name="avg_minutes" inputmode="numeric" value="20" maxlength="3"></label>
  <button class="btn" type="submit">سجّل حضوري — أنا موجود</button>
</form>`;
  return page('لوحة الحلاق', user, html);
  }
  const entries = q.barberQueue.all(user.id);
  const served = q.servedToday.get(user.id).n;
  const serving = entries.find(e => e.status === 'serving');
  const waiting = entries.filter(e => e.status === 'waiting');
  const list = entries.map((e, i) => {
    const num = e.status === 'serving' ? 'بيتحلق' : 'رقم ' + (waiting.indexOf(e) + 1);
    const actions = e.status === 'serving'
      ? `<form method="post" action="/queue/done" class="inline"><input type="hidden" name="id" value="${e.id}"><button class="btn small" type="submit">خلّص</button></form>`
      : `<form method="post" action="/queue/remove" class="inline"><input type="hidden" name="id" value="${e.id}"><button class="btn small ghost" type="submit">شيل</button></form>`;
    return `<div class="qrow ${e.status}">
      <span class="qnum">${num}</span>
      <span class="qname">${esc(e.customer_name)}</span>
      <span class="qsvc">${esc(e.service || '')}</span>
      <span class="qphone"><a href="tel:${esc(e.customer_phone)}">${esc(e.customer_phone)}</a></span>
      <span class="qtime">${timeHM(e.joined_at)}</span>
      ${actions}
    </div>`;
  }).join('');
  html += `
<div class="notice ok">إنت مسجل حضور من ${timeHM(checkin.checked_in_at)}${checkin.shop_name ? ' · ' + esc(checkin.shop_name) : ''} — الزبائن شايفاك.</div>
<div class="stats">
  <div>خلصت النهارده: <strong>${served}</strong></div>
  <div>في الانتظار: <strong>${waiting.length}</strong></div>
</div>
${serving
  ? `<form method="post" action="/queue/done" class="inline"><input type="hidden" name="id" value="${serving.id}"><button class="btn" type="submit">خلّص ${esc(serving.customer_name)} وندّه على اللي بعده</button></form>`
  : (waiting.length
      ? `<form method="post" action="/queue/next" class="inline"><button class="btn" type="submit">اللي بعده — ندّه على ${esc(waiting[0].customer_name)}</button></form>`
      : `<div class="empty">الدور فاضي. أول زبون يدخل هيظهر هنا.</div>`)}
${list ? `<div class="qlist">${list}</div>` : ''}
<form method="post" action="/checkout" class="mt"><button class="btn danger" type="submit">سجّل انصراف — قفلت</button></form>
<p class="muted small-note">الصفحة بتتحدث لوحدها كل شوية.</p>`;
  const lastAny = db.prepare('SELECT COALESCE(MAX(id),0) AS last FROM queue WHERE barber_id = ?').get(user.id).last;
  html += `<div id="alertBox" class="alertbox" data-last="${lastAny}" data-waiting="${waiting.length}">
  <button id="enableAlerts" class="btn small ghost" type="button">🔔 فعّل تنبيه الزبون الجديد</button>
  <span id="alertStatus" class="muted small-note"></span>
</div><script src="/alerts.js"></script>`;
  return page('لوحة الحلاق', user, '<div id="newBanner" class="newbanner" hidden>🔔 عندك زبون جديد!</div>' + html);
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const route = url.pathname;
    const user = currentUser(req);

    // static files
    if (req.method === 'GET' && (route === '/style.css' || route === '/sw.js' || route === '/alerts.js' || route === '/manifest.webmanifest' || route.startsWith('/icons/'))) {
      const fp = path.join(__dirname, 'public', route.replace(/^\//, ''));
      if (!fp.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('nf'); }
      const ext = path.extname(fp);
      const types = { '.css': 'text/css', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': route.startsWith('/icons/') ? 'public, max-age=86400' : 'no-cache' });
      return res.end(fs.readFileSync(fp));
    }

    const send = (html, code = 200) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); };
    const redirect = (to, msg) => {
      if (msg) to += (to.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent(msg);
      res.writeHead(303, { Location: to }); res.end();
    };

    if (req.method === 'GET') {
      const msg = url.searchParams.get('msg') || '';
      if (route === '/') {
        if (!user) return send(landingPage(msg));
        return redirect(user.role === 'barber' ? '/dashboard' : '/board');
      }
      if (route === '/signup') return send(user ? page('حساب جديد', user, '<div class="notice">إنت مسجل دخول بالفعل.</div>') : signupPage(msg));
      if (route === '/login') return send(loginPage(msg));
      if (route === '/logout') {
        const sid = parseCookies(req)['sid'];
        if (sid) q.deleteSession.run(sid);
        res.writeHead(303, { Location: '/', 'Set-Cookie': 'sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' });
        return res.end();
      }
      if (route === '/api/push-key') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(VAPID_PUBLIC); }
      if (route === '/api/state') {
        if (!user || user.role !== 'barber') { res.writeHead(401); return res.end('{}'); }
        const w = db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS last FROM queue WHERE barber_id = ? AND status = 'waiting'").get(user.id);
        const lastAny = db.prepare('SELECT COALESCE(MAX(id),0) AS last FROM queue WHERE barber_id = ?').get(user.id).last;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ waiting: w.n, lastId: lastAny }));
      }
      if (route === '/board') {
        if (!user) return redirect('/login', 'سجّل دخول الأول');
        return send(boardPage(user, msg));
      }
      if (route === '/status') {
        if (!user) return redirect('/login', 'سجّل دخول الأول');
        if (user.role !== 'customer') return redirect('/dashboard');
        return send(statusPage(user, msg));
      }
      if (route === '/dashboard') {
        if (!user) return redirect('/login', 'سجّل دخول الأول');
        if (user.role !== 'barber') return redirect('/board');
        return send(dashboardPage(user, msg));
      }
      res.writeHead(404); return res.end('not found');
    }

    if (req.method === 'POST') {
      const body = await readBody(req);

      if (route === '/signup') {
        const name = (body.get('name') || '').trim();
        const phone = (body.get('phone') || '').trim();
        const password = body.get('password') || '';
        const role = body.get('role') || '';
        if (!name || !phone || password.length < 6 || !['barber', 'customer'].includes(role)) {
          return redirect('/signup', 'كمّل البيانات صح — وكلمة السر 6 حروف على الأقل');
        }
        if (phone.replace(/\D/g, '').length < 8) return redirect('/signup', 'رقم الموبايل مش مظبوط');
        if (q.userByPhone.get(phone)) return redirect('/signup', 'الرقم ده مسجل قبل كده — جرّب تدخل');
        const info = q.insertUser.run(name, phone, hashPassword(password), role);
        const token = crypto.randomBytes(24).toString('hex');
        q.insertSession.run(token, info.lastInsertRowid);
        res.writeHead(303, { Location: '/', 'Set-Cookie': `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` });
        return res.end();
      }

      if (route === '/login') {
        const phone = (body.get('phone') || '').trim();
        const password = body.get('password') || '';
        const u = q.userByPhone.get(phone);
        if (!u || !verifyPassword(password, u.password_hash)) return redirect('/login', 'الرقم أو كلمة السر غلط');
        const token = crypto.randomBytes(24).toString('hex');
        q.insertSession.run(token, u.id);
        res.writeHead(303, { Location: '/', 'Set-Cookie': `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` });
        return res.end();
      }

      if (!user) return redirect('/login', 'سجّل دخول الأول');

      if (route === '/push/subscribe' || route === '/push/unsubscribe') {
        if (user.role !== 'barber') { res.writeHead(403); return res.end('barbers only'); }
        const endpoint = body.get('endpoint') || '';
        if (!/^https:\/\//.test(endpoint) && !(process.env.ALLOW_HTTP_PUSH && /^http:\/\//.test(endpoint))) { res.writeHead(400); return res.end('bad endpoint'); }
        db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
        if (route === '/push/subscribe') db.prepare('INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES (?,?,?,?)').run(user.id, endpoint, body.get('p256dh') || '', body.get('auth') || '');
        res.writeHead(200); return res.end('ok');
      }
      if (route === '/checkin') {
        if (user.role !== 'barber') return redirect('/board');
        const existing = q.openCheckin.get(user.id);
        if (existing) q.closeCheckin.run(existing.id);
        const shop = (body.get('shop_name') || '').trim();
        const avg = Math.min(180, Math.max(5, parseInt(body.get('avg_minutes') || '20', 10) || 20));
        q.insertCheckin.run(user.id, shop, avg);
        return redirect('/dashboard', 'تم تسجيل حضورك — الزبائن شايفاك دلوقتي');
      }

      if (route === '/checkout') {
        if (user.role !== 'barber') return redirect('/board');
        const existing = q.openCheckin.get(user.id);
        if (existing) q.closeCheckin.run(existing.id);
        return redirect('/dashboard', 'سجّلنا انصرافك — اتشلت من قايمة الموجودين');
      }

      if (route === '/join') {
        if (user.role !== 'customer') return redirect('/dashboard');
        const barberId = parseInt(body.get('barber_id') || '0', 10);
        const service = (body.get('service') || '').trim().slice(0, 60);
        const phone = (body.get('phone') || '').trim().slice(0, 20);
        if (phone.replace(/\D/g, '').length < 8) return redirect('/board', 'رقم الموبايل إجباري عشان تاخد دور');
        const barber = q.userById.get(barberId);
        if (!barber || barber.role !== 'barber' || !q.openCheckin.get(barberId)) {
          return redirect('/board', 'الحلاق ده مش موجود دلوقتي');
        }
        if (q.activeEntryForCustomer.get(user.id)) return redirect('/status', 'إنت واخد دور بالفعل');
        q.insertQueue.run(barberId, user.id, service, phone);
        pushToUser(barberId);
        return redirect('/status', 'اخدت الدور — تابع مكانك من هنا');
      }

      if (route === '/leave') {
        const entry = q.activeEntryForCustomer.get(user.id);
        if (entry) q.setStatus.run('left', 'left', 'left', entry.id);
        return redirect('/board', 'سيبت الدور');
      }

      if (route === '/queue/next' || route === '/queue/done' || route === '/queue/remove') {
        if (user.role !== 'barber') return redirect('/board');
        if (route === '/queue/next') {
          const entries = q.barberQueue.all(user.id);
          if (entries.some(e => e.status === 'serving')) return redirect('/dashboard', 'خلّص اللي بيتحلق الأول');
          const next = entries.find(e => e.status === 'waiting');
          if (!next) return redirect('/dashboard', 'مفيش حد في الانتظار');
          q.setStatus.run('serving', 'serving', 'serving', next.id);
          return redirect('/dashboard', 'ندّيت على ' + next.customer_name);
        }
        const id = parseInt(body.get('id') || '0', 10);
        const entry = q.queueEntry.get(id);
        if (!entry || entry.barber_id !== user.id) return redirect('/dashboard', 'المشكلة دي مش بتاعتك');
        if (route === '/queue/done') {
          q.setStatus.run('done', 'done', 'done', id);
          const next = q.barberQueue.all(user.id).find(e => e.status === 'waiting');
          if (next) q.setStatus.run('serving', 'serving', 'serving', next.id);
          return redirect('/dashboard', next ? 'خلصت وندّيت على اللي بعده' : 'خلصت — الدور فاضي');
        }
        q.setStatus.run('left', 'left', 'left', id);
        return redirect('/dashboard', 'اتشال من الدور');
      }

      res.writeHead(404); return res.end('not found');
    }

    res.writeHead(405); res.end();
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('حصلت مشكلة — جرّب تاني');
  }
});

server.listen(PORT, () => console.log(`${APP_NAME} on http://localhost:${PORT}`));
