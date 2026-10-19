// DW POS — dashboard pemilik (hanya baca). Data dari Supabase, dikunci RLS:
// hanya akun pemilik/anggota outlet yang bisa melihat datanya.
'use strict';

const SUPABASE_URL = 'https://xanbbebvspuuvvgehlbc.supabase.co';
// Kunci publik (publishable) — memang untuk aplikasi; keamanan data dijaga RLS.
const SUPABASE_KEY = 'sb_publishable_ZfI33IgvrEr3_fpTO7DHgA_-tbGl8Ob';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const $ = (id) => document.getElementById(id);
const METHOD = { cash: 'Tunai', qris: 'QRIS', transfer: 'Transfer', debit: 'Debit' };
const state = { outletId: null, outlets: [], period: 'today', from: null, to: null, timer: null, orders: [], names: {}, payByOrder: {} };

// ------------------------------------------------------------ util
const rp = (n) => (n < 0 ? '-' : '') + 'Rp' + Math.abs(Math.round(n || 0)).toLocaleString('id-ID');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const two = (n) => String(n).padStart(2, '0');
const hhmm = (iso) => { if (!iso) return '-'; const d = new Date(iso); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
const dmy = (iso) => { const d = new Date(iso); return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()}`; };
const orderNo = (r) => '#' + String(r || '').split('-').pop();
const orderTitle = (o) => [o.table_label, o.customer_name].filter((x) => x && String(x).trim()).join(' · ') || (o.order_type === 'dinein' ? 'Pesanan' : 'Bawa pulang');
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const ymd = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const sum = (arr, f) => arr.reduce((n, x) => n + (f(x) || 0), 0);

function setLoading(on) { $('loading').hidden = !on; }

/** Ambil semua baris (Supabase membatasi 1000 per permintaan). */
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

/** Kueri dengan daftar id panjang dipecah per 150 agar URL tidak terlalu panjang. */
async function fetchIn(table, cols, key, ids, extra) {
  const out = [];
  for (let i = 0; i < ids.length; i += 150) {
    const part = ids.slice(i, i + 150);
    out.push(...await fetchAll(() => { let q = sb.from(table).select(cols).in(key, part); return extra ? extra(q) : q; }));
  }
  return out;
}

// ------------------------------------------------------------ periode
function computeRange() {
  const today = startOfDay(new Date());
  switch (state.period) {
    case 'yesterday': return [addDays(today, -1), today];
    case 'week': return [addDays(today, -6), addDays(today, 1)];
    case 'month': return [new Date(today.getFullYear(), today.getMonth(), 1), addDays(today, 1)];
    case 'custom': {
      const f = $('fromDate').value, t = $('toDate').value;
      if (!f || !t) return [today, addDays(today, 1)];
      const a = new Date(f + 'T00:00'), b = new Date(t + 'T00:00');
      return a <= b ? [a, addDays(b, 1)] : [b, addDays(a, 1)];
    }
    default: return [today, addDays(today, 1)];
  }
}

// ------------------------------------------------------------ login
async function showLogin() {
  $('loginView').hidden = false;
  $('dashView').hidden = true;
  $('topActions').hidden = true;
  $('who').textContent = 'Dashboard pemilik';
  $('outletName').textContent = 'DW POS';
  clearInterval(state.timer);
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').hidden = true;
  $('loginBtn').disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
  $('loginBtn').disabled = false;
  if (error) {
    $('loginError').textContent = /invalid/i.test(error.message) ? 'Email atau kata sandi salah.' : 'Gagal masuk: ' + error.message;
    $('loginError').hidden = false;
    return;
  }
  $('password').value = '';
  await start();
});

$('logoutBtn').addEventListener('click', async () => { await sb.auth.signOut(); showLogin(); });
$('refreshBtn').addEventListener('click', () => load());
$('outletSelect').addEventListener('change', (e) => { state.outletId = e.target.value; localStorageSet('outlet', state.outletId); load(); });

function localStorageGet(k) { try { return localStorage.getItem('dwpos.' + k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem('dwpos.' + k, v); } catch { /* abaikan */ } }

// ------------------------------------------------------------ periode UI
$('periodChips').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.period = b.dataset.p;
  document.querySelectorAll('#periodChips button').forEach((x) => x.classList.toggle('on', x === b));
  $('customRange').hidden = state.period !== 'custom';
  if (state.period !== 'custom') load();
});
$('applyRange').addEventListener('click', () => load());

// ------------------------------------------------------------ mulai
async function start() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return showLogin();
  $('loginView').hidden = true;
  $('dashView').hidden = false;
  $('topActions').hidden = false;
  $('who').textContent = session.user.email;
  const today = startOfDay(new Date());
  $('fromDate').value = ymd(addDays(today, -6));
  $('toDate').value = ymd(today);

  const { data: outlets, error } = await sb.from('outlets').select('id,name').order('name');
  if (error) { alert('Gagal memuat outlet: ' + error.message); return; }
  if (!outlets.length) {
    $('liveShift').innerHTML = '<div class="card">Akun ini belum punya outlet. Hubungkan aplikasi kasir ke cloud dulu.</div>';
    return;
  }
  // Aktivitas terakhir tiap outlet (data terakhir yang dikirim perangkat), agar
  // outlet lama hasil "daftar ulang" mudah dibedakan dari outlet yang dipakai.
  await Promise.all(outlets.map(async (o) => {
    const { data } = await sb.from('audit_log').select('at').eq('outlet_id', o.id).order('at', { ascending: false }).limit(1);
    o.lastAt = data && data[0] ? data[0].at : null;
  }));
  outlets.sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));
  state.outlets = outlets;
  const saved = localStorageGet('outlet');
  state.outletId = outlets.some((o) => o.id === saved) ? saved : outlets[0].id;
  const sel = $('outletSelect');
  const sameName = new Set(outlets.map((o) => o.name)).size < outlets.length;
  sel.innerHTML = outlets.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}${sameName || outlets.length > 1 ? ` · aktif ${o.lastAt ? dmy(o.lastAt) + ' ' + hhmm(o.lastAt) : '-'}` : ''}</option>`).join('');
  sel.value = state.outletId;
  sel.hidden = outlets.length < 2;

  await load();
  clearInterval(state.timer);
  state.timer = setInterval(load, 60000);
}

// ------------------------------------------------------------ muat data
async function load() {
  if (!state.outletId) return;
  const oid = state.outletId;
  const [from, to] = computeRange();
  state.from = from; state.to = to;
  const F = from.toISOString(), T = to.toISOString();
  $('outletName').textContent = state.outlets.find((o) => o.id === oid)?.name || 'DW POS';
  setLoading(true);
  try {
    const [employees, paid, voided, payments, expenses, shifts, openShifts, openOrders] = await Promise.all([
      fetchAll(() => sb.from('employees').select('id,name').eq('outlet_id', oid)),
      fetchAll(() => sb.from('orders').select('id,receipt_number,table_label,customer_name,order_type,total,discount_total,paid_at,created_at,employee_id,status').eq('outlet_id', oid).eq('status', 'paid').gte('paid_at', F).lt('paid_at', T).order('paid_at')),
      fetchAll(() => sb.from('orders').select('id,receipt_number,table_label,customer_name,order_type,total,voided_at,void_reason,created_at,status').eq('outlet_id', oid).eq('status', 'voided').gte('voided_at', F).lt('voided_at', T)),
      fetchAll(() => sb.from('payments').select('order_id,method,amount,created_at').eq('outlet_id', oid).gte('created_at', F).lt('created_at', T)),
      fetchAll(() => sb.from('expenses').select('id,category,item,amount,source,created_at,employee_id').eq('outlet_id', oid).is('voided_at', null).gte('created_at', F).lt('created_at', T).order('created_at')),
      fetchAll(() => sb.from('shifts').select('*').eq('outlet_id', oid).lt('opened_at', T).or(`closed_at.gte.${F},closed_at.is.null`).order('opened_at', { ascending: false })),
      fetchAll(() => sb.from('shifts').select('*').eq('outlet_id', oid).is('closed_at', null).order('opened_at', { ascending: false })),
      fetchAll(() => sb.from('orders').select('id,total').eq('outlet_id', oid).eq('status', 'open')),
    ]);
    state.names = Object.fromEntries(employees.map((e) => [e.id, e.name]));

    // Metode bayar per pesanan (untuk tabel transaksi).
    const paidIds = paid.map((o) => o.id);
    const orderPays = paidIds.length ? await fetchIn('payments', 'order_id,method,amount', 'order_id', paidIds) : [];
    state.payByOrder = {};
    for (const p of orderPays) (state.payByOrder[p.order_id] ||= new Set()).add(METHOD[p.method] || p.method);

    // Menu terlaris dari pesanan lunas.
    const lines = paidIds.length ? await fetchIn('order_lines', 'order_id,name_snapshot,qty,unit_price,status', 'order_id', paidIds, (q) => q.eq('status', 'active')) : [];

    // Shift berjalan: uang diterima di shift itu.
    const live = openShifts[0];
    state.openShifts = openShifts;
    state.lastAt = state.outlets.find((o) => o.id === oid)?.lastAt;
    const livePays = live ? await fetchAll(() => sb.from('payments').select('amount,method,order_id').eq('shift_id', live.id)) : [];
    const liveExp = live ? await fetchAll(() => sb.from('expenses').select('amount').eq('shift_id', live.id).is('voided_at', null)) : [];
    const liveMoves = live ? await fetchAll(() => sb.from('cash_movements').select('direction,amount').eq('shift_id', live.id)) : [];

    state.orders = paid.map((o) => ({ ...o, _status: 'Lunas' })).concat(voided.map((o) => ({ ...o, _status: 'Batal', paid_at: o.voided_at })));
    state.orders.sort((a, b) => new Date(a.paid_at) - new Date(b.paid_at));

    renderLive(live, livePays, liveExp, liveMoves, openOrders);
    renderKpis(paid, voided, expenses);
    renderHours(paid);
    renderMethods(payments);
    renderItems(lines);
    renderExpenses(expenses);
    // Shift yang angka lacinya dikoreksi pemilik/manager.
    const corrected = shifts.length
      ? await fetchIn('audit_log', 'entity_id,detail', 'entity_id', shifts.map((x) => x.id), (q) => q.eq('action', 'shift.correct'))
      : [];
    state.corrections = {};
    for (const c of corrected) (state.corrections[c.entity_id] ||= []).push(c.detail || {});
    renderShifts(shifts);
    renderOrders();
    $('updatedAt').textContent = 'Diperbarui ' + hhmm(new Date().toISOString());
  } catch (err) {
    console.error(err);
    if (String(err.message || err).match(/JWT|auth/i)) return showLogin();
    $('updatedAt').textContent = 'Gagal memuat: ' + (err.message || err);
  } finally {
    setLoading(false);
  }
}

// ------------------------------------------------------------ tampilan
function renderLive(shift, pays, exps, moves, openOrders) {
  if (!shift) {
    $('liveShift').innerHTML = `<div class="card live"><span><span class="dot closed"></span><b>Kasir sedang tutup</b></span><span class="muted">Belum ada shift berjalan.</span><span class="muted small">Data terakhir dari perangkat: ${state.lastAt ? dmy(state.lastAt) + ' ' + hhmm(state.lastAt) : '-'}</span></div>`;
    return;
  }
  const received = sum(pays, (p) => p.amount);
  const cash = sum(pays.filter((p) => p.method === 'cash'), (p) => p.amount);
  const cin = sum(moves.filter((m) => m.direction === 'in'), (m) => m.amount);
  const cout = sum(moves.filter((m) => m.direction === 'out'), (m) => m.amount);
  const expected = shift.opening_cash + cash + cin - cout;
  const ageH = (Date.now() - new Date(shift.opened_at)) / 3600000;
  const others = (state.openShifts || []).slice(1);
  const warn = ageH > 14 || others.length
    ? `<div class="warn">⚠ ${ageH > 14 ? `Shift ini dibuka ${Math.floor(ageH)} jam lalu dan menurut cloud belum ditutup. ` : ''}${others.length ? `Ada ${others.length + 1} shift terbuka di cloud. ` : ''}
       Kemungkinan: (1) sudah ditutup di perangkat tetapi belum terkirim, cek ikon awan di tablet/HP harus centang; (2) dashboard sedang menampilkan outlet lama, pilih outlet lain di kanan atas; (3) shift dibuka di perangkat yang datanya sudah dihapus.</div>`
    : '';
  $('liveShift').innerHTML = `
    <div class="card live">
      <span><span class="dot"></span><b>Shift ${esc(state.names[shift.employee_id] || '-')}</b> <span class="muted">sejak ${dmy(shift.opened_at)} ${hhmm(shift.opened_at)}</span></span>
      <span>Diterima <b>${rp(received)}</b></span>
      <span>Lunas <b>${new Set(pays.map((p) => p.order_id)).size}</b></span>
      <span>Belum dibayar <b>${openOrders.length}</b> <span class="muted">(${rp(sum(openOrders, (o) => o.total))})</span></span>
      <span>Belanja <b>${rp(sum(exps, (e) => e.amount))}</b></span>
      <span>Laci menurut sistem <b>${rp(expected)}</b></span>
      <span class="muted small">Data terakhir dari perangkat: ${state.lastAt ? dmy(state.lastAt) + ' ' + hhmm(state.lastAt) : '-'}</span>
      ${warn}
    </div>`;
}

function renderKpis(paid, voided, expenses) {
  const revenue = sum(paid, (o) => o.total);
  const spent = sum(expenses, (e) => e.amount);
  const k = (label, value, main) => `<div class="kpi${main ? ' main' : ''}"><span>${label}</span><b>${value}</b></div>`;
  $('kpis').innerHTML = [
    k('Omzet', rp(revenue), true),
    k('Transaksi lunas', paid.length),
    k('Rata-rata / transaksi', rp(paid.length ? revenue / paid.length : 0)),
    k('Belanja', rp(spent)),
    k('Omzet − belanja', rp(revenue - spent)),
    k('Diskon', rp(sum(paid, (o) => o.discount_total))),
    k('Pesanan dibatalkan', `${voided.length} · ${rp(sum(voided, (o) => o.total))}`),
  ].join('');
}

function renderHours(paid) {
  const by = new Array(24).fill(0);
  for (const o of paid) by[new Date(o.paid_at).getHours()] += o.total;
  const active = by.map((v, h) => (v > 0 ? h : -1)).filter((h) => h >= 0);
  if (!active.length) { $('hourChart').innerHTML = '<p class="empty">Belum ada penjualan.</p>'; return; }
  const lo = active[0], hi = active[active.length - 1], max = Math.max(...by);
  let html = '';
  for (let h = lo; h <= hi; h++) {
    const pct = by[h] ? Math.max(2, (by[h] / max) * 100) : 0;
    html += `<div class="bar${by[h] === max ? ' peak' : ''}" title="${two(h)}:00 · ${rp(by[h])}"><i style="height:${pct}%"></i><small>${two(h)}</small></div>`;
  }
  $('hourChart').innerHTML = html;
}

function kvRows(rows, empty) {
  return rows.length ? rows.map(([a, b]) => `<div class="kv"><span class="k">${a}</span><span class="v">${b}</span></div>`).join('') : `<p class="empty">${empty}</p>`;
}

function renderMethods(payments) {
  const by = {};
  for (const p of payments) by[p.method] = (by[p.method] || 0) + p.amount;
  const rows = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([m, v]) => [esc(METHOD[m] || m), rp(v)]);
  $('methods').innerHTML = kvRows(rows, 'Belum ada pembayaran.');
}

function renderItems(lines) {
  const by = {};
  for (const l of lines) { const x = (by[l.name_snapshot] ||= { qty: 0, gross: 0 }); x.qty += l.qty; x.gross += l.qty * l.unit_price; }
  const rows = Object.entries(by).sort((a, b) => b[1].qty - a[1].qty).slice(0, 15).map(([n, x]) => [`${esc(n)} <span class="muted">× ${x.qty}</span>`, rp(x.gross)]);
  $('topItems').innerHTML = kvRows(rows, 'Belum ada menu terjual.');
}

function renderExpenses(expenses) {
  const multiDay = state.to - state.from > 86400000;
  const rows = expenses.map((e) => [
    `${esc(e.item)} <span class="muted">· ${esc(e.category)} · ${multiDay ? dmy(e.created_at) + ' ' : ''}${hhmm(e.created_at)}${e.source === 'owner' ? ' · uang pemilik' : ''}</span>`,
    rp(e.amount),
  ]);
  if (rows.length) rows.push(['<b>Total</b>', `<b>${rp(sum(expenses, (e) => e.amount))}</b>`]);
  $('expenses').innerHTML = kvRows(rows, 'Tidak ada belanja.');
}

function renderShifts(shifts) {
  if (!shifts.length) { $('shiftTable').innerHTML = '<tr><td class="empty">Tidak ada shift di periode ini.</td></tr>'; return; }
  const head = '<tr><th>Kasir</th><th>Buka</th><th>Tutup</th><th class="num">Modal</th><th class="num">Kas sistem</th><th class="num">Dihitung</th><th class="num">Selisih</th><th class="num">Disetor</th><th>Diperiksa</th></tr>';
  const body = shifts.map((s) => {
    const open = !s.closed_at;
    const diff = s.cash_difference;
    const diffCell = open || diff == null ? '-' : diff === 0 ? '<span class="pos">0</span>' : `<span class="neg">${diff > 0 ? 'kurang ' : 'lebih '}${rp(Math.abs(diff))}</span>`;
    return `<tr>
      <td>${esc(state.names[s.employee_id] || '-')}</td>
      <td>${dmy(s.opened_at)} ${hhmm(s.opened_at)}</td>
      <td>${open ? '<span class="tag">berjalan</span>' : hhmm(s.closed_at)}</td>
      <td class="num">${rp(s.opening_cash)}</td>
      <td class="num">${open ? '-' : rp(s.expected_cash)}</td>
      <td class="num">${open ? '-' : rp(s.counted_cash)}</td>
      <td class="num">${diffCell}${state.corrections?.[s.id] ? ` <span class="tag" title="${esc(state.corrections[s.id].map((d) => d.reason).join(' | '))}">dikoreksi</span>` : ''}</td>
      <td class="num">${s.deposited_cash ? rp(s.deposited_cash) : '-'}</td>
      <td>${s.reviewed_at ? '✓' : open ? '' : '<span class="muted">belum</span>'}</td>
    </tr>`;
  }).join('');
  $('shiftTable').innerHTML = head + body;
}

function renderOrders() {
  const list = state.orders;
  if (!list.length) { $('orderTable').innerHTML = '<tr><td class="empty">Tidak ada transaksi.</td></tr>'; return; }
  const multiDay = state.to - state.from > 86400000;
  const head = '<tr><th>No</th><th>Waktu</th><th>Pesanan</th><th>Kasir</th><th>Metode</th><th class="num">Total</th><th>Status</th></tr>';
  const body = list.slice().reverse().slice(0, 300).map((o) => `<tr>
      <td>${esc(orderNo(o.receipt_number))}</td>
      <td>${multiDay ? dmy(o.paid_at) + ' ' : ''}${hhmm(o.paid_at)}</td>
      <td>${esc(orderTitle(o))}</td>
      <td>${esc(state.names[o.employee_id] || '')}</td>
      <td>${esc([...(state.payByOrder[o.id] || [])].join(' + '))}</td>
      <td class="num">${rp(o.total)}</td>
      <td>${o._status === 'Batal' ? `<span class="tag void" title="${esc(o.void_reason)}">Batal</span>` : '<span class="tag">Lunas</span>'}</td>
    </tr>`).join('');
  const more = list.length > 300 ? `<tr><td colspan="7" class="muted">Menampilkan 300 terbaru dari ${list.length}. Unduh CSV untuk semuanya.</td></tr>` : '';
  $('orderTable').innerHTML = head + body + more;
}

// ------------------------------------------------------------ CSV
$('exportBtn').addEventListener('click', () => {
  const rows = [['No struk', 'Tanggal', 'Jam', 'Pesanan', 'Kasir', 'Metode', 'Total', 'Status', 'Alasan batal']];
  for (const o of state.orders) {
    rows.push([o.receipt_number, dmy(o.paid_at), hhmm(o.paid_at), orderTitle(o), state.names[o.employee_id] || '', [...(state.payByOrder[o.id] || [])].join(' + '), o.total, o._status, o.void_reason || '']);
  }
  // Pemisah titik koma agar langsung rapi di Excel berbahasa Indonesia.
  const csv = '﻿' + rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `transaksi-${ymd(state.from)}-${ymd(addDays(state.to, -1))}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

start();
