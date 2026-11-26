// Seeds demo data into a running Alcoach. Usage: node seed-demo.js http://localhost:3000
const base = process.argv[2] || 'http://localhost:3000';
async function post(path, data, cookie) {
  const r = await fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: cookie || '' }, body: new URLSearchParams(data) });
  const sc = (r.headers.get('set-cookie') || '').split(';')[0];
  return sc.startsWith('sid=') && sc.length > 5 ? sc : cookie;
}
async function acct(name, phone, role) {
  let c = await post('/signup', { name, phone, password: 'demo1234', role });
  if (!c) c = await post('/login', { phone, password: 'demo1234' });
  return c;
}
(async () => {
  const b1 = await acct('الكوتش', '01100000001', 'barber');
  const b2 = await acct('مصطفى الحلاق', '01100000002', 'barber');
  await post('/checkin', { shop_name: 'صالون الكوتش', avg_minutes: '20' }, b1);
  await post('/checkin', { shop_name: 'مصطفى للحلاقة', avg_minutes: '25' }, b2);
  const names = ['يوسف', 'عمر', 'خالد'];
  const bid = [1, 1, 2];
  for (let i = 0; i < names.length; i++) {
    const c = await acct('زبون ' + names[i], '0120000000' + (i + 1), 'customer');
    await post('/join', { barber_id: String(bid[i]), service: i == 1 ? 'حلاقة + دقن' : 'حلاقة', phone: '0120000000' + (i + 1) }, c);
  }
  console.log('seeded. Demo logins (password demo1234): barbers 01100000001, 01100000002; customers 01200000001..3');
})();
