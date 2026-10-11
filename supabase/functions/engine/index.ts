// @ts-nocheck
// 24시 모의선물 서버 엔진 (Supabase Edge Function, 이름: engine)
// 1분마다 pg_cron 이 불러요. 앱이 3분 넘게 닫혀 있는 사람의 예약 체결·익절·손절·청산을 대신 확인하고,
// 체결되면 그 사람 기기로 알림(웹 푸시)을 보내요. 앱이 열려 있는 동안은 앱이 직접 확인해요.
// 규칙은 index.html 의 catchUp()·fillOrder()·execute() 를 그대로 옮긴 것이에요. 거래 규칙을 바꾸면 두 곳을 함께 고쳐요.
// 비밀값은 코드에 없어요. 데이터베이스 주소(SUPABASE_DB_URL)는 Supabase 가 자동으로 넣어 줘요.
import postgres from 'npm:postgres@3.4.9';

const API = 'https://api.hyperliquid.xyz/info';
const OKX = 'https://www.okx.com/api/v5/';
const HL_DEXES = ['', 'xyz', 'para', 'io', 'mkts'];
const START = 10000, SALARY = 10000, FEE = 0.0005;
const KST = 9 * 36e5;                       // 월급날은 한국 시간 매달 1일 0시
const IDLE_MS = 3 * 60e3;                   // 앱이 이만큼 조용하면 서버가 대신 확인
const APP_URL = 'https://first-best.github.io/mock-futures/';
const IV_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 };
const OKX_BAR = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1Dutc' };

// ───────── 숫자·이름 (앱과 같은 모양) ─────────
const r2 = v => Math.round(v * 100) / 100;
const sig = v => +(+v).toPrecision(10);
const tick = s => String(s).replace(/^[a-z]+:/, '');
const isOkx = c => c.startsWith('okx:');
const pxDec = p => { if (!isFinite(p) || p <= 0) return 2; return Math.min(6, Math.max(0, 5 - Math.floor(Math.log10(p)))); };
const fPx = p => isFinite(p) && p > 0 ? p.toLocaleString('en-US', { minimumFractionDigits: pxDec(p), maximumFractionDigits: pxDec(p) }) : '–';
const fUsd = (v, sign) => { if (!isFinite(v)) return '–'; const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return (sign ? (v > 0 ? '+' : v < 0 ? '−' : '') : (v < 0 ? '−' : '')) + s; };
const uid = () => Math.random().toString(36).slice(2, 10);
const COIN_RE = /^[A-Za-z0-9:_.-]{1,40}$/;
const modeName = m => m === 'cross' ? '교차' : '격리';
// 한국 시간 기준 달 번호(연×12+월)와 그 달 1일 0시
export const monthIdx = t => { const d = new Date(t + KST); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
export const monthStart = mi => Date.UTC(Math.floor(mi / 12), mi % 12, 1) - KST;

// ───────── 서버 상태(state) ↔ 계산용 기록 ─────────
// 앱의 fromSnap() 과 같아요. mx = 종목 최대 레버리지(유지증거금률 계산용), nm = 종목 이름(알림 문장용)
export function load(st, levOf) {
  const n = v => +v || 0, mode = m => m === 'isolated' ? 'isolated' : 'cross', id = v => /^\w{1,16}$/.test(v) ? v : uid();
  const S = { balance: n(st.bal), deposited: n(st.dep) || START, paidThrough: Number.isFinite(st.pt) ? st.pt : null, rev: n(st.rev), positions: [], orders: [], mx: {}, nm: {} };
  const meta = x => { if (+x.mx > 0) S.mx[x.c] = +x.mx; else if (!S.mx[x.c] && levOf?.(x.c)) S.mx[x.c] = levOf(x.c); if (x.nm && typeof x.nm === 'string') S.nm[x.c] = x.nm.slice(0, 30); };
  for (const p of st.pos || []) {
    if (!COIN_RE.test(p.c) || !(n(p.sz) > 0)) continue; meta(p);
    S.positions.push({ id: id(p.id), coin: p.c, dir: p.d > 0 ? 1 : -1, size: n(p.sz), entry: n(p.e), lev: n(p.lev) || 1, mode: mode(p.m), margin: p.m === 'isolated' ? n(p.mg) : 0, tp: n(p.tp) || null, sl: n(p.sl) || null, fees: n(p.f), openedAt: n(p.t) || 0 });
  }
  for (const o of st.ord || []) {
    if (!COIN_RE.test(o.c) || !(n(o.px) > 0)) continue; meta(o);
    S.orders.push({ id: id(o.id), coin: o.c, dir: o.d > 0 ? 1 : -1, px: n(o.px), margin: n(o.mg), lev: n(o.lev) || 1, mode: mode(o.m), tp: n(o.tp) || null, sl: n(o.sl) || null, at: n(o.t) || 0, res: n(o.res), ...(o.ro ? { ro: true } : {}) });
  }
  return S;
}
// 앱의 snapshot() 과 같은 모양으로 되돌려요 (모르는 칸은 그대로 둬요)
export function dump(S, orig, ls) {
  const extra = c => ({ ...(S.mx[c] ? { mx: S.mx[c] } : {}), ...(S.nm[c] ? { nm: S.nm[c] } : {}) });
  return { ...orig, v: 1, rev: S.rev, bal: r2(S.balance), dep: S.deposited, pt: S.paidThrough, ls,
    pos: S.positions.map(p => ({ c: p.coin, d: p.dir, sz: sig(p.size), e: sig(p.entry), m: p.mode, mg: r2(p.margin), lev: p.lev, tp: p.tp || null, sl: p.sl || null, f: sig(p.fees || 0), t: p.openedAt, id: p.id, ...extra(p.coin) })),
    ord: S.orders.map(o => ({ id: o.id, c: o.coin, d: o.dir, px: sig(o.px), mg: r2(o.margin), lev: o.lev, m: o.mode, tp: o.tp || null, sl: o.sl || null, t: o.at, res: r2(o.res || 0), ...(o.ro ? { ro: 1 } : {}), ...extra(o.coin) })) };
}

// ───────── 거래 규칙 (index.html 과 같은 계산) ─────────
// X = { S, events: [], msgs: [] }. 앱의 note() 대신 events 에, toast() 대신 msgs 에 담아요.
function rules(X) {
  const S = X.S;
  const nameOf = c => S.nm[c] || tick(c);
  const mmr = c => 1 / (2 * (S.mx[c] || 20));
  const posOf = c => S.positions.find(p => p.coin === c);
  const upnlAt = (p, px, size = p.size) => (px - p.entry) * size * p.dir;
  const sideName = p => nameOf(p.coin) + ' ' + (p.dir > 0 ? '롱' : '숏');
  const note = ev => X.events.push({ ...ev, srv: 1 });
  function liqPrice(dir, entry, margin, size, coin) { const r = mmr(coin), per = margin / size; return dir > 0 ? Math.max(0, (entry - per) / (1 - r)) : (entry + per) / (1 + r); }
  function crossState(pxOf, skip) {
    let U = 0, MM = 0, IM = 0, n = 0, miss = 0;
    for (const p of S.positions) {
      if (p.mode !== 'cross' || p.coin === skip) continue;
      const px = pxOf(p.coin); if (!px) { miss++; continue; }
      n++; U += upnlAt(p, px); MM += p.size * px * mmr(p.coin); IM += p.size * px / p.lev;
    }
    return { n, miss, U, MM, IM, E: S.balance + U };
  }
  function liqOf(p, pxOf) {
    if (p.mode === 'isolated') return liqPrice(p.dir, p.entry, p.margin, p.size, p.coin);
    const o = crossState(pxOf, p.coin), r = mmr(p.coin), s = p.size;
    const x = p.dir > 0 ? (o.MM - o.E + p.entry * s) / (s * (1 - r)) : (o.E - o.MM + p.entry * s) / (s * (1 + r));
    return x > 0 ? x : 0;
  }
  const liqTxt = (p, pxOf) => { const lq = liqOf(p, pxOf); return lq > 0 ? (p.mode === 'cross' ? '약 ' : '') + fPx(lq) : '없음'; };
  function account(pxOf) {
    const cr = crossState(pxOf);
    const res = S.orders.reduce((a, o) => a + (o.res || 0), 0);
    return { cr, avail: Math.max(0, cr.E - cr.IM - res) };
  }
  function plan(c, dir, margin, lev, mode, px) {
    const p = posOf(c); if (p) { lev = p.lev; mode = p.mode; }
    const notional = margin * lev, q = notional / px, dust = sz => sz * px < 1;
    if (!p) return { px, act: '진입', close: 0, open: q, hp: { coin: c, dir, size: q, entry: px, lev, mode, margin: mode === 'isolated' ? margin : 0 } };
    if (p.dir === dir) return { px, act: '더하기', close: 0, open: q, hp: { ...p, size: p.size + q, entry: (p.entry * p.size + px * q) / (p.size + q), margin: p.mode === 'isolated' ? p.margin + margin : 0 } };
    if (q < p.size && !dust(p.size - q)) return { px, act: '줄이기', close: q, open: 0, hp: { ...p, size: p.size - q, margin: p.margin * (1 - q / p.size) } };
    const rest = q - p.size;
    if (dust(rest)) return { px, act: '종료', close: p.size, open: 0, hp: null };
    return { px, act: '뒤집기', close: p.size, open: rest, hp: { coin: c, dir, size: rest, entry: px, lev: p.lev, mode: p.mode, margin: p.mode === 'isolated' ? rest * px / p.lev : 0 } };
  }
  function logTrade(p, size, exit, reason, at, realized) {
    note({ k: 'trade', r: reason, c: p.coin, d: p.dir, sz: sig(size), e: sig(p.entry), px: sig(exit), pnl: r2(realized), m: p.mode, lev: p.lev, at });
  }
  function reducePosition(p, q, price, reason, at) {
    const all = q >= p.size * (1 - 1e-9), f = all ? 1 : q / p.size;
    q = all ? p.size : q;
    const pnl = upnlAt(p, price, q), fee = q * price * FEE, feeShare = p.fees * f;
    let realized;
    if (p.mode === 'isolated') { const m = p.margin * f, back = Math.max(0, m + pnl - fee); S.balance += back; p.margin -= m; realized = back - m - feeShare; }
    else { S.balance += pnl - fee; realized = pnl - fee - feeShare; }
    p.fees -= feeShare; p.size -= q;
    if (all) S.positions.splice(S.positions.indexOf(p), 1);
    logTrade(p, q, price, reason, at, realized);
    return realized;
  }
  function liquidateIso(p, price, at) {
    S.positions.splice(S.positions.indexOf(p), 1);
    logTrade(p, p.size, price, '청산', at, -p.margin - p.fees);
  }
  function liquidateCross(pxOf, at) {
    const cr = crossState(pxOf), list = S.positions.filter(p => p.mode === 'cross');
    for (const p of list) {
      const px = pxOf(p.coin) || p.entry, mm = p.size * px * mmr(p.coin);
      const realized = upnlAt(p, px) - p.fees - cr.E * (cr.MM ? mm / cr.MM : 1 / list.length);
      S.positions.splice(S.positions.indexOf(p), 1);
      logTrade(p, p.size, px, '교차 청산', at, realized);
    }
    S.balance = 0;
    return list.map(sideName).join(', ');
  }
  function execute(c, dir, v, { tp = null, sl = null, at, pxOf, lim = false }) {
    const msg = [];
    if (v.close) {
      const p = posOf(c), r = reducePosition(p, v.close, v.px, lim ? '예약 체결' : '반대 주문', at);
      msg.push(`${v.act === '줄이기' ? '일부 정리' : '종료'} · 실현손익 ${fUsd(r, true)} USDC`);
    }
    if (v.open) {
      const ntl = v.open * v.px, im = ntl / v.hp.lev, fee = ntl * FEE, p = posOf(c);
      if (im + fee > account(pxOf).avail + 1e-9) msg.push(v.close ? '뒤집는 주문은 사용 가능한 돈이 부족해서 넣지 않았어요.' : '사용 가능한 돈이 부족해서 주문하지 못했어요.');
      else {
        if (p && p.dir === dir) { p.entry = (p.entry * p.size + v.px * v.open) / (p.size + v.open); p.size += v.open; p.fees += fee; if (p.mode === 'isolated') { p.margin += im; S.balance -= im; } }
        else {
          S.positions.push({ id: uid(), coin: c, dir, size: v.open, entry: v.px, lev: v.hp.lev, mode: v.hp.mode, margin: v.hp.mode === 'isolated' ? im : 0, tp: null, sl: null, fees: fee, openedAt: at });
          if (v.hp.mode === 'isolated') S.balance -= im;
        }
        S.balance -= fee;
        note({ k: v.act === '더하기' ? 'add' : 'open', c, d: dir, sz: sig(v.open), px: sig(v.px), m: v.hp.mode, lev: v.hp.lev, ...(lim ? { lim: 1 } : {}), at });
        const np = posOf(c);
        msg.push(v.act === '더하기' ? `새 평균가 ${fPx(np.entry)} · 청산가 ${liqTxt(np, pxOf)}` : `${modeName(np.mode)} ${np.lev}배 진입 · 청산가 ${liqTxt(np, pxOf)}`);
      }
    }
    const np = posOf(c);
    if (np) { if (tp) np.tp = tp; if (sl) np.sl = sl; }
    return msg;
  }
  function fillOrder(o, at, pxOf) {
    S.orders.splice(S.orders.indexOf(o), 1);
    const head = `${nameOf(o.coin)} ${o.dir > 0 ? '롱' : '숏'} 예약 ${fPx(o.px)}`, p = posOf(o.coin);
    let v = plan(o.coin, o.dir, o.margin, o.lev, o.mode, o.px);
    if (o.ro) {
      if (!p || p.dir === o.dir) { note({ k: 'cancel', id: o.id, c: o.coin, why: 'ro' }); return null; }
      if (v.act === '뒤집기') v = { ...v, act: '종료', open: 0, hp: null };
    }
    if (v.act !== '뒤집기' && v.open) {
      const ntl = v.open * v.px;
      if (ntl / v.hp.lev + ntl * FEE > account(pxOf).avail + 1e-9) { note({ k: 'cancel', id: o.id, c: o.coin, why: 'funds' }); return { title: '예약 취소 · ' + head, body: '사용 가능한 돈이 부족해서 취소됐어요.' }; }
    }
    return { title: '예약 체결 · ' + head, body: execute(o.coin, o.dir, v, { tp: o.tp, sl: o.sl, at, pxOf, lim: true }).join(' · ') };
  }
  function payday(at) {
    S.balance += SALARY; S.deposited += SALARY; S.paidThrough = monthIdx(at);
    note({ k: 'pay', amt: SALARY, at });
  }
  // 앱의 commit(): 정리하려던 포지션이 없어진 '정리' 예약은 취소
  function cleanup() {
    for (const o of [...S.orders]) if (o.ro) { const p = posOf(o.coin); if (!p || p.dir === o.dir) { S.orders.splice(S.orders.indexOf(o), 1); note({ k: 'cancel', id: o.id, c: o.coin, why: 'ro' }); } }
  }
  return { nameOf, sideName, posOf, liqOf, crossState, liquidateIso, liquidateCross, reducePosition, fillOrder, payday, cleanup, mmr };
}

// 이 사람에게 필요한 봉 간격 (앱의 catchUp 과 같아요)
export function pickIv(coins, gap) {
  const D = 864e5;
  return coins.some(isOkx)
    ? (gap < D ? '1m' : gap < 5 * D ? '5m' : gap < 15 * D ? '15m' : gap < 60 * D ? '1h' : gap < 240 * D ? '4h' : '1d')
    : (gap < 3 * D ? '1m' : gap < 16 * D ? '5m' : gap < 200 * D ? '1h' : '1d');
}

// from ~ now 를 봉 순서대로 되짚어요 (앱의 catchUp 과 같은 순서: 월급 → 격리 청산 → 손절 → 익절 → 교차 청산 → 예약 체결)
// kOf(c) = 그 종목 봉 배열(시간순) 또는 null(못 받음). 돌려주는 값: { changed, events, msgs, miss }
export function simulate(S, { from, now, iv, kOf }) {
  const X = { S, events: [], msgs: [] }, R = rules(X), ms = IV_MS[iv];
  if (S.paidThrough == null) S.paidThrough = monthIdx(from);
  const pays = []; for (let mi = S.paidThrough + 1; monthStart(mi) <= now && pays.length < 120; mi++) pays.push(monthStart(mi));
  let pi = 0; const pay = t => { while (pi < pays.length && pays[pi] <= t) R.payday(pays[pi++]); };
  const coins = [...new Set([...S.positions, ...S.orders].map(p => p.coin))];
  const at = {}, lastC = {};
  for (const c of coins) { const ks = (kOf(c) || []).filter(k => k.t + ms > from - 60e3 && k.t <= now); at[c] = new Map(ks.map(k => [k.t, k])); lastC[c] = ks[0]?.o; }
  const times = [...new Set(coins.flatMap(c => [...at[c].keys()]))].sort((a, b) => a - b);
  const push = (title, body) => X.msgs.push({ title, body });
  for (const t of times) {
    pay(t);
    for (const p of [...S.positions]) {
      const k = at[p.coin]?.get(t); if (!k || p.openedAt > t + ms) continue;
      const worst = p.dir > 0 ? k.l : k.h, best = p.dir > 0 ? k.h : k.l, name = R.sideName(p);
      if (p.mode === 'isolated') { const lq = R.liqOf(p); if (p.dir > 0 ? worst <= lq : worst >= lq) { R.liquidateIso(p, lq, t); push(`청산 · ${name} 격리 ${p.lev}배`, `증거금 ${fUsd(p.margin)} USDC를 잃었어요. (청산가 ${fPx(lq)})`); continue; } }
      if (p.sl && (p.dir > 0 ? worst <= p.sl : worst >= p.sl)) { const r = R.reducePosition(p, p.size, p.sl, '손절', t); push(`손절 · ${name}`, `${fPx(p.sl)}에 정리 · ${fUsd(r, true)} USDC`); continue; }
      if (p.tp && (p.dir > 0 ? best >= p.tp : best <= p.tp)) { const r = R.reducePosition(p, p.size, p.tp, '익절', t); push(`익절 · ${name}`, `${fPx(p.tp)}에 정리 · ${fUsd(r, true)} USDC`); }
    }
    const worstOf = c => { const k = at[c]?.get(t), p = R.posOf(c); return k && p ? (p.dir > 0 ? k.l : k.h) : lastC[c]; };
    const cr = R.crossState(worstOf);
    if (cr.n && !cr.miss && cr.E < cr.MM) push('교차 청산 · ' + R.liquidateCross(worstOf, t), '교차 자산이 유지증거금보다 작아져서 교차 포지션이 한꺼번에 정리됐어요. 격리 포지션은 그대로예요.');
    const closeOf = c => at[c]?.get(t)?.c ?? lastC[c];
    for (const o of [...S.orders]) {
      const k = at[o.coin]?.get(t); if (!k || !S.orders.includes(o) || o.at > t) continue;
      if (o.dir > 0 ? k.l <= o.px : k.h >= o.px) { const m = R.fillOrder(o, t, closeOf); if (m) X.msgs.push(m); }
    }
    coins.forEach(c => { const k = at[c]?.get(t); if (k) lastC[c] = k.c; });
  }
  pay(now);
  const changed = X.events.length > 0;
  if (changed) { R.cleanup(); S.rev += 1; }
  return { changed, events: X.events, msgs: X.msgs, miss: coins.filter(c => !at[c].size) };
}

// ───────── 시세 ─────────
async function getJson(fetchFn, url, init, ms = 15000) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetchFn(url, { ...init, signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(to); }
}
const hlPost = (fetchFn, body) => getJson(fetchFn, API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function okxGet(fetchFn, path) { const j = await getJson(fetchFn, OKX + path); if (j.code !== '0') throw new Error(j.msg || 'okx ' + j.code); return j.data; }
export async function candles(fetchFn, coin, iv, start, end) {
  if (!isOkx(coin)) {
    const rows = await hlPost(fetchFn, { type: 'candleSnapshot', req: { coin, interval: iv, startTime: Math.floor(start), endTime: Math.floor(end) } });
    if (!Array.isArray(rows)) throw new Error('candles ' + coin);
    return rows.map(r => ({ t: r.t, o: +r.o, h: +r.h, l: +r.l, c: +r.c })).sort((a, b) => a.t - b.t);
  }
  const ms = IV_MS[iv], got = new Map(), id = tick(coin) + '-USDT-SWAP';
  let after = Math.floor(end) + 1, hist = false;
  for (let i = 0; i < 25; i++) {
    const rows = await okxGet(fetchFn, `market/${hist ? 'history-candles' : 'candles'}?instId=${id}&bar=${OKX_BAR[iv]}&limit=${hist ? 100 : 300}&after=${after}`);
    if (!rows.length) { if (hist) break; hist = true; continue; }
    for (const r of rows) got.set(+r[0], { t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] });
    after = +rows.at(-1)[0];
    if (after <= start) break;
  }
  return [...got.values()].filter(k => k.t + ms > start && k.t <= end).sort((a, b) => a.t - b.t);
}
// 종목 최대 레버리지 (상태에 mx 가 없는 예전 기록용). 하루에 한 번 새로 받아요.
async function levTable(fetchFn) {
  const out = {};
  await Promise.all(HL_DEXES.map(async d => {
    try { const m = await hlPost(fetchFn, d ? { type: 'meta', dex: d } : { type: 'meta' }); for (const u of m.universe || []) out[u.name] = u.maxLeverage; } catch (e) {}
  }));
  try { for (const x of await okxGet(fetchFn, 'public/instruments?instType=SWAP')) if (/-USDT-SWAP$/.test(x.instId)) out['okx:' + x.instId.replace(/-USDT-SWAP$/, '')] = +x.lever || 10; } catch (e) {}
  return out;
}

// ───────── 웹 푸시 (RFC 8291 암호화 + RFC 8292 VAPID 서명) ─────────
const te = new TextEncoder();
export const b64u = {
  enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => { s = String(s).replace(/=+$/, ''); return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0)); },
};
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
export async function makeVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { pub: b64u.enc(await crypto.subtle.exportKey('raw', kp.publicKey)), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
}
export async function vapidHeader(endpoint, vapid, now = Date.now()) {
  const enc = o => b64u.enc(te.encode(JSON.stringify(o)));
  const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: APP_URL });
  const key = await crypto.subtle.importKey('jwk', vapid.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const s = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(unsigned));
  return `vapid t=${unsigned}.${b64u.enc(s)}, k=${vapid.pub}`;
}
export async function encryptPush(sub, text) {
  const ua = b64u.dec(sub.p256dh), auth = b64u.dec(sub.auth);
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const hkdf = async (salt, ikm, info, len) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), len * 8));
  const ikm = await hkdf(auth, secret, cat(te.encode('WebPush: info\0'), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(te.encode(text), new Uint8Array([2]))));
  const head = new Uint8Array(21 + asPub.length);
  head.set(salt, 0); new DataView(head.buffer).setUint32(16, 4096); head[20] = asPub.length; head.set(asPub, 21);
  return cat(head, ct);
}
export async function sendPush(fetchFn, sub, msg, vapid) {
  const body = await encryptPush(sub, JSON.stringify(msg));
  const r = await fetchFn(sub.endpoint, { method: 'POST', body, headers: {
    Authorization: await vapidHeader(sub.endpoint, vapid), TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' } });
  try { await r.arrayBuffer(); } catch (e) {}
  return r.status;
}

// ───────── 한 번 돌기 ─────────
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } })); }

export async function run(sql, { fetchFn = fetch, now = Date.now(), force = false } = {}) {
  const t0 = Date.now();
  const [meta] = force
    ? await sql`update engine_meta set ran_at = now() where id = 1 returning *`
    : await sql`update engine_meta set ran_at = now() where id = 1 and (ran_at is null or ran_at < now() - interval '40 seconds') returning *`;
  if (!meta) return { skip: 'too_soon' };
  const out = { at: new Date(now).toISOString(), players: 0, changed: 0, raced: 0, waiting: 0, events: 0, pushes: 0, pushFail: 0, gone: 0, nt: 0, errors: [] };
  const err = e => { if (out.errors.length < 10) out.errors.push(String(e?.message || e).slice(0, 200)); };

  // 알림 서명 열쇠: 처음 돌 때 만들어서 데이터베이스(아무도 못 읽는 표)에 둬요
  let vapid = meta.vapid_public && meta.vapid_private ? { pub: meta.vapid_public, jwk: meta.vapid_private } : null;
  if (!vapid) {
    const v = await makeVapid();
    await sql`update engine_meta set vapid_public = ${v.pub}, vapid_private = ${sql.json(v.jwk)} where id = 1 and vapid_public is null`;
    const [m2] = await sql`select vapid_public, vapid_private from engine_meta where id = 1`;
    vapid = { pub: m2.vapid_public, jwk: m2.vapid_private };
  }
  const subsOf = new Map();
  const pushTo = async (player, msgs) => {
    if (!msgs.length) return;
    if (!subsOf.has(player)) subsOf.set(player, await sql`select endpoint, p256dh, auth from push_subs where player = ${player}`);
    for (const sub of subsOf.get(player)) for (const m of msgs.slice(-5)) {
      try {
        const st = await sendPush(fetchFn, sub, { title: m.title, body: m.body, tag: m.tag || uid(), url: './' }, vapid);
        if (st === 404 || st === 410) { await sql`delete from push_subs where endpoint = ${sub.endpoint}`; out.gone++; break; }
        if (st >= 200 && st < 300) out.pushes++; else { out.pushFail++; err('push ' + st + ' ' + new URL(sub.endpoint).host); }
      } catch (e) { out.pushFail++; err(e); }
    }
  };

  // 앱이 3분 넘게 닫혀 있고 포지션이나 예약이 있는 사람
  const rows = (await sql`
    select id, state, updated_at from players
     where (active_at is null or active_at < now() - make_interval(secs => ${IDLE_MS / 1000}))
       and jsonb_typeof(state -> 'bal') = 'number'
       and ((jsonb_typeof(state -> 'pos') = 'array' and jsonb_array_length(state -> 'pos') > 0)
         or (jsonb_typeof(state -> 'ord') = 'array' and jsonb_array_length(state -> 'ord') > 0))
     order by id limit 500`);
  out.players = rows.length;

  // 예전 기록(mx 없음)이 있으면 종목 최대 레버리지 표를 받아요 (하루 한 번)
  let lev = meta.lev || {};
  const needLev = rows.some(r => [...(r.state.pos || []), ...(r.state.ord || [])].some(x => !(+x.mx > 0) && !lev[x.c]));
  if (needLev && (!meta.lev_at || now - Date.parse(meta.lev_at) > 864e5)) {
    try { const t = await levTable(fetchFn); if (Object.keys(t).length) { lev = t; await sql`update engine_meta set lev = ${sql.json(t)}, lev_at = now() where id = 1`; } } catch (e) { err(e); }
  }

  // 사람마다 확인할 구간과 봉 간격을 정하고, 같은 종목·간격의 봉은 한 번만 받아요
  const jobs = rows.map(r => {
    const S = load(r.state, c => lev[c]);
    const from = Math.min(now, +r.state.ls > 0 ? +r.state.ls : Date.parse(r.updated_at) || now);
    const coins = [...new Set([...S.positions, ...S.orders].map(p => p.coin))];
    return { r, S, from, coins, iv: pickIv(coins, now - from) };
  });
  const want = new Map();
  for (const j of jobs) for (const c of j.coins) { const k = c + '|' + j.iv, w = want.get(k); if (!w || j.from < w.from) want.set(k, { c, iv: j.iv, from: j.from }); }
  const got = new Map();
  await pool([...want.entries()], 4, async ([k, w]) => {
    try { got.set(k, await candles(fetchFn, w.c, w.iv, w.from - 60e3, now)); }
    catch (e) { got.set(k, null); err(w.c + ' ' + (e?.message || e)); }
  });

  for (const j of jobs) {
    // 시세를 받다가 오류가 난 종목이 있으면 이번엔 건너뛰고 다음 1분에 다시 해요 (빠뜨리지 않게)
    if (j.coins.some(c => got.get(c + '|' + j.iv) === null)) { out.waiting++; continue; }
    const rev0 = j.S.rev;
    try {
      const res = simulate(j.S, { from: j.from, now, iv: j.iv, kOf: c => got.get(c + '|' + j.iv) });
      if (!res.changed) {
        // 바뀐 게 없으면 확인한 시각(ls)만 남겨요. rev 는 그대로라 앱이 덮어쓰지 않아요.
        await sql`update players set state = jsonb_set(state, '{ls}', ${now}::text::jsonb) where id = ${j.r.id} and rev_of(state) = ${rev0}`;
        continue;
      }
      const st = dump(j.S, j.r.state, now);
      const ok = await sql`update players set state = ${sql.json(st)}, updated_at = now() where id = ${j.r.id} and rev_of(state) = ${rev0} returning id`;
      if (!ok.length) { out.raced++; continue; }   // 그 사이 앱이 열려서 바꿨어요. 앱 쪽 기록을 따라요.
      out.changed++; out.events += res.events.length;
      await sql`insert into events (player, body) select ${j.r.id}, e from jsonb_array_elements(${sql.json(res.events)}) as e`;
      await pushTo(j.r.id, res.msgs.map((m, i) => ({ ...m, tag: `${j.r.id.slice(0, 8)}-${now}-${i}` })));
    } catch (e) { err(e); }
  }

  // 앱이 뒤에 숨어 있을 때 체결돼서 앱이 맡긴 알림 (30분 넘게 묵은 건 버려요)
  try {
    const [{ mx }] = await sql`select coalesce(max(id), 0)::bigint as mx from events`;
    const nts = await sql`select id, player, body ->> 't' as t, body ->> 'b' as b from events
      where id > ${meta.last_event} and id <= ${mx} and body ->> 'k' = 'nt' and server_at > now() - interval '30 minutes' order by id limit 300`;
    await sql`update engine_meta set last_event = ${mx} where id = 1`;
    const by = new Map(); for (const n of nts) (by.get(n.player) || by.set(n.player, []).get(n.player)).push(n);
    for (const [player, list] of by) {
      out.nt += list.length;
      await pushTo(player, list.map(n => ({ title: String(n.t || '24시 모의선물').slice(0, 100), body: String(n.b || '').slice(0, 300), tag: 'nt-' + n.id })));
    }
  } catch (e) { err(e); }

  out.ms = Date.now() - t0;
  await sql`update engine_meta set last_result = ${sql.json(out)} where id = 1`;
  return out;
}

// 예약 실행(pg_cron)이 보내는 열쇠(x-engine-key)가 맞을 때만 돌아요
export async function handler(req) {
  const sql = postgres(Deno.env.get('SUPABASE_DB_URL'), { prepare: false, max: 1, idle_timeout: 5, connect_timeout: 15 });
  try {
    const [m] = await sql`select cron_key from engine_meta where id = 1`;
    const key = req.headers.get('x-engine-key') || '';
    if (!m || key.length < 24 || key !== m.cron_key) return Response.json({ error: 'forbidden' }, { status: 403 });
    return Response.json(await run(sql));
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  } finally { await sql.end({ timeout: 3 }); }
}
if (!Deno.env.get('ENGINE_TEST')) Deno.serve(handler);
