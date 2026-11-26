(function () {
  var box = document.getElementById('alertBox');
  if (!box) return;
  var last = parseInt(box.dataset.last, 10) || 0;
  var baseTitle = document.title;
  var btn = document.getElementById('enableAlerts');
  var status = document.getElementById('alertStatus');
  var ctx = null;
  function beep() {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25].forEach(function (t) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.25, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.22);
      });
    } catch (e) {}
  }
  function setBadge(n) {
    document.title = (n > 0 ? '(' + n + ') ' : '') + baseTitle;
    try { if (navigator.setAppBadge) { n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } } catch (e) {}
  }
  var w0 = parseInt(box.dataset.waiting, 10) || 0;
  setBadge(w0);
  if (sessionStorage.getItem('newcust')) {
    sessionStorage.removeItem('newcust');
    var b = document.getElementById('newBanner'); if (b) { b.hidden = false; setTimeout(function () { b.hidden = true; }, 8000); }
  }
  function tick() {
    fetch('/api/state', { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (s) {
      if (typeof s.lastId !== 'number') return;
      if (s.lastId > last) {
        last = s.lastId;
        beep();
        if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
        sessionStorage.setItem('newcust', '1');
        setBadge(s.waiting);
        location.reload();
      } else if (s.waiting !== w0) { w0 = s.waiting; location.reload(); }
    }).catch(function () {});
  }
  setInterval(tick, 4000);
  function urlB64(b) { var p = '='.repeat((4 - b.length % 4) % 4); var s = (b + p).replace(/-/g, '+').replace(/_/g, '/'); var r = atob(s); return Uint8Array.from(r, function (c) { return c.charCodeAt(0); }); }
  function secure() { return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  async function enable() {
    beep(); // unlocks sound in this browser session
    try { localStorage.setItem('alertsOn', '1'); } catch (e) {}
    if (!secure()) { status.textContent = 'التنبيه جوه التطبيق شغال (صوت واهتزاز). التنبيه وهو مقفول محتاج الموقع على https.'; return; }
    var perm = await Notification.requestPermission();
    if (perm !== 'granted') { status.textContent = 'اسمح بالإشعارات من إعدادات المتصفح.'; return; }
    var reg = await navigator.serviceWorker.ready;
    var key = await (await fetch('/api/push-key')).text();
    var sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key.trim()) });
    var j = sub.toJSON(); var k = j.keys || {};
    await fetch('/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ endpoint: j.endpoint, p256dh: k.p256dh || '', auth: k.auth || '' }) });
    status.textContent = '✔ التنبيهات شغالة حتى لو التطبيق مقفول.';
    btn.hidden = true;
  }
  btn.onclick = function () { enable().catch(function (e) { status.textContent = 'تعذر التفعيل: ' + e.message; }); };
  if (localStorage.getItem('alertsOn')) { status.textContent = 'التنبيه الصوتي مفعّل. اضغط الزر لو الصوت مش شغال.'; }
})();
