// Split / balance logic. All money is integer cents (USD).
(function (root) {
  'use strict';

  function parseMoney(str) {
    if (typeof str === 'number') return Number.isFinite(str) ? Math.round(Math.round(str * 1e6) / 1e4) : NaN;
    const s = String(str == null ? '' : str).trim().replace(/[$,\s]/g, '');
    const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m || (m[2] === '' && !m[3])) return NaN;
    const frac = (m[3] || '').padEnd(3, '0');
    let c = Number(m[2] || '0') * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
    if (!Number.isSafeInteger(c)) return NaN;
    return m[1] && c ? -c : c;
  }

  function fmt(cents, opts) {
    const r = Math.round(cents);
    const neg = r < 0;
    const a = Math.abs(r);
    const d = Math.floor(a / 100), c = String(a % 100).padStart(2, '0');
    const s = '$' + d.toLocaleString('en-US') + '.' + c;
    return neg ? (opts && opts.paren ? '(' + s + ')' : '-' + s) : s;
  }

  // Split totalCents by weights using largest remainder. Deterministic: ties go to
  // the id that appears first in the given order.
  function allocate(totalCents, weights) {
    const ids = Object.keys(weights).filter(k => weights[k] > 0);
    const out = Object.create(null);
    const sumW = ids.reduce((a, k) => a + weights[k], 0);
    if (!ids.length || sumW <= 0) return out;
    const sign = totalCents < 0 ? -1 : 1;
    const T = Math.abs(totalCents);
    let used = 0;
    const rem = ids.map((k, i) => {
      const exact = T * weights[k] / sumW;
      const fl = Math.floor(exact + 1e-9);
      out[k] = fl; used += fl;
      return { k, r: exact - fl, i };
    });
    let left = T - used;
    rem.sort((a, b) => (b.r - a.r) || (a.i - b.i));
    for (let j = 0; left > 0; j = (j + 1) % rem.length, left--) out[rem[j].k]++;
    for (const k of ids) { if (!out[k]) delete out[k]; else if (sign < 0) out[k] = -out[k]; }
    return { ...out };
  }

  const MODES = ['equal', 'exact', 'percent', 'shares', 'adjust'];

  // spec: {mode, values:{memberId: number}}
  //   equal:   values[id] truthy => included
  //   exact:   values[id] = cents
  //   percent: values[id] = percent (sum 100)
  //   shares:  values[id] = share count (>0)
  //   adjust:  values[id] = +/- cents on top of an equal split of the rest; key present => included
  // returns {ok, amounts:{id:cents}, error}
  function computeSplit(totalCents, spec) {
    if (!Number.isInteger(totalCents) || totalCents <= 0) return { ok: false, error: 'Total must be more than $0.00.' };
    if (!spec || MODES.indexOf(spec.mode) < 0) return { ok: false, error: 'Unknown split method.' };
    const v = spec.values || {};
    const ids = Object.keys(v);
    const num = k => v[k];
    if (spec.mode !== 'equal' && ids.some(k => typeof v[k] !== 'number' || !Number.isFinite(v[k]))) return { ok: false, error: 'Every value must be a number.' };
    if ((spec.mode === 'exact' || spec.mode === 'adjust') && ids.some(k => !Number.isInteger(v[k]))) return { ok: false, error: 'Amounts must be whole cents.' };

    if (spec.mode === 'equal') {
      const inc = ids.filter(k => v[k] === true || v[k] === 1);
      if (!inc.length) return { ok: false, error: 'Pick at least one person.' };
      const w = Object.create(null); inc.forEach(k => { w[k] = 1; });
      return { ok: true, amounts: allocate(totalCents, w) };
    }
    if (spec.mode === 'exact') {
      const amounts = Object.create(null); let sum = 0;
      for (const k of ids) {
        const c = num(k);
        if (c < 0) return { ok: false, error: 'Amounts cannot be negative.' };
        if (c > 0) { amounts[k] = c; sum += c; }
      }
      if (!Object.keys(amounts).length) return { ok: false, error: 'Enter at least one amount.' };
      if (sum !== totalCents) {
        const d = totalCents - sum;
        return { ok: false, error: (d > 0 ? fmt(d) + ' left to assign.' : fmt(-d) + ' over the total.'), diff: d };
      }
      return { ok: true, amounts: { ...amounts } };
    }
    if (spec.mode === 'percent' || spec.mode === 'shares') {
      const w = Object.create(null); let sum = 0;
      for (const k of ids) {
        const x = num(k);
        if (x < 0) return { ok: false, error: 'Values cannot be negative.' };
        if (x > 0) { w[k] = x; sum += x; }
      }
      if (!Object.keys(w).length) return { ok: false, error: spec.mode === 'percent' ? 'Enter at least one percentage.' : 'Give at least one person a share.' };
      if (spec.mode === 'percent' && Math.abs(sum - 100) > 1e-6) {
        const d = Math.round((100 - sum) * 1000) / 1000;
        return { ok: false, error: (d > 0 ? d + '% left to assign.' : (-d) + '% over 100%.'), diff: d };
      }
      return { ok: true, amounts: allocate(totalCents, w) };
    }
    // adjust
    if (!ids.length) return { ok: false, error: 'Pick at least one person.' };
    let adjSum = 0;
    for (const k of ids) adjSum += num(k);
    const base = totalCents - adjSum;
    if (base < 0) return { ok: false, error: 'Adjustments are more than the total.' };
    const w = Object.create(null); ids.forEach(k => { w[k] = 1; });
    const eq = allocate(base, w);
    const amounts = Object.create(null);
    for (const k of ids) {
      const a = (eq[k] || 0) + num(k);
      if (a < 0) return { ok: false, error: 'An adjustment makes someone’s share negative.' };
      if (a > 0) amounts[k] = a;
    }
    return { ok: true, amounts: { ...amounts } };
  }

  // Validate a whole expense: {amount, paid:spec, owed:spec}
  function evaluateExpense(e) {
    const total = e.amount;
    if (!Number.isInteger(total) || total <= 0) return { ok: false, error: 'Enter an amount more than $0.00.' };
    const p = computeSplit(total, e.paid);
    if (!p.ok) return { ok: false, error: 'Paid by: ' + p.error };
    const o = computeSplit(total, e.owed);
    if (!o.ok) return { ok: false, error: 'Split: ' + o.error };
    return { ok: true, paid: p.amounts, owed: o.amounts };
  }

  // Each record: {type:'expense', amount, paid, owed, deleted?} or {type:'payment', from, to, amount, deleted?}
  // net: + is owed money, - owes. debts: direct who-owes-whom (per pair, from expenses and payments).
  function ledger(records) {
    const D = () => Object.create(null);
    const net = D(), paidTot = D(), owedTot = D(), pair = new Map();
    const add = (o, k, x) => { o[k] = (o[k] || 0) + x; };
    // pair map keyed by [from,to] via nested Maps; store signed amount on canonical order
    const addPair = (from, to, x) => {
      if (from === to || !x) return;
      const [a, b, sg] = from < to ? [from, to, 1] : [to, from, -1];
      if (!pair.has(a)) pair.set(a, new Map());
      const m = pair.get(a); m.set(b, (m.get(b) || 0) + sg * x);
    };
    let spend = 0;
    const invalid = [];
    for (const r of records) {
      if (!r || r.deleted) continue;
      if (r.type === 'payment') {
        if (!Number.isInteger(r.amount) || r.amount <= 0 || typeof r.from !== 'string' || typeof r.to !== 'string' || !r.from || !r.to || r.from === r.to) { invalid.push(r); continue; }
        add(net, r.from, r.amount); add(net, r.to, -r.amount);
        addPair(r.to, r.from, r.amount);
        continue;
      }
      if (r.type !== 'expense') { invalid.push(r); continue; }
      const ev0 = evaluateExpense(r);
      if (!ev0.ok) { invalid.push(r); continue; }
      const ev = { paid: Object.assign(D(), ev0.paid), owed: Object.assign(D(), ev0.owed) };
      spend += r.amount;
      const ids = [];
      for (const k of Object.keys(ev.paid).concat(Object.keys(ev.owed))) if (ids.indexOf(k) < 0) ids.push(k);
      const local = D();
      for (const k of ids) {
        local[k] = (ev.paid[k] || 0) - (ev.owed[k] || 0);
        add(net, k, local[k]); add(paidTot, k, ev.paid[k] || 0); add(owedTot, k, ev.owed[k] || 0);
      }
      // waterfall: debtors pay creditors in order; exact by construction
      const cr = ids.filter(k => local[k] > 0).map(k => ({ k, a: local[k] }));
      const db = ids.filter(k => local[k] < 0).map(k => ({ k, a: -local[k] }));
      let i = 0, j = 0;
      while (i < db.length && j < cr.length) {
        const x = Math.min(db[i].a, cr[j].a);
        addPair(db[i].k, cr[j].k, x);
        db[i].a -= x; cr[j].a -= x;
        if (!db[i].a) i++;
        if (!cr[j].a) j++;
      }
    }
    const debts = [];
    for (const [a, m] of pair) for (const [b, v] of m) {
      if (v > 0) debts.push({ from: a, to: b, amount: v });
      else if (v < 0) debts.push({ from: b, to: a, amount: -v });
    }
    debts.sort((x, y) => (y.amount - x.amount) || (x.from < y.from ? -1 : x.from > y.from ? 1 : 0));
    return { net: { ...net }, paid: { ...paidTot }, owed: { ...owedTot }, debts, spend, invalid };
  }

  // Fewest-ish transfers from net balances (greedy largest-first). At most n-1 transfers.
  function simplify(net) {
    const cr = [], db = [];
    for (const k of Object.keys(net)) {
      if (net[k] > 0) cr.push({ k, a: net[k] }); else if (net[k] < 0) db.push({ k, a: -net[k] });
    }
    const out = [];
    const by = (x, y) => (y.a - x.a) || (x.k < y.k ? -1 : 1);
    while (cr.length && db.length) {
      cr.sort(by); db.sort(by);
      const c = cr[0], d = db[0];
      const x = Math.min(c.a, d.a);
      out.push({ from: d.k, to: c.k, amount: x });
      c.a -= x; d.a -= x;
      if (!c.a) cr.shift();
      if (!d.a) db.shift();
    }
    return out;
  }

  const api = { parseMoney, fmt, allocate, computeSplit, evaluateExpense, ledger, simplify, MODES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SplitLogic = api;
})(typeof window !== 'undefined' ? window : this);
