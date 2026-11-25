// Supabase-backed store with the same small API the page uses (doc/collection, get/set/update/delete, onSnapshot).
// Table: public.docs(path text pk, parent text, data jsonb, updated_at timestamptz)
(function (root) {
  'use strict';
  function makeSupaDB(sb) {
    const T = 'docs';
    const PAGE = 1000;
    const parentOf = p => p.split('/').slice(0, -1).join('/');
    const err = (e) => {
      const msg = (e && e.message) || String(e);
      const code = e && (e.code === '42501' || /row-level security|permission/i.test(msg)) ? 'invalid_argument' : 'unavailable';
      return { code, message: msg };
    };
    const denied = () => ({ code: 'invalid_argument', message: 'Not allowed to change this row' });
    const snapDoc = (path, data) => ({ id: path.split('/').pop(), exists: !!data, data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined), metadata: { fromCache: false, hasPendingWrites: false } });
    const toSnap = rows => { const docs = rows.map(r => snapDoc(r.path, r.data)); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } }; };
    const listeners = new Map(); // parent -> Set(refetch)
    const poke = (parent) => { const s = listeners.get(parent); if (s) s.forEach(f => f()); };
    let channel = null, rtOk = false;
    function ensureChannel() {
      if (channel) return;
      channel = sb.channel('docs-all')
        .on('postgres_changes', { event: '*', schema: 'public', table: T }, payload => {
          const row = (payload.new && payload.new.path) ? payload.new : payload.old;
          if (row && row.parent != null) poke(row.parent);
          else if (row && row.path) poke(parentOf(row.path));
          else listeners.forEach(s => s.forEach(f => f()));
        })
        .subscribe(status => { rtOk = status === 'SUBSCRIBED'; });
    }
    async function getFull(path) {
      const { data, error } = await sb.from(T).select('data,updated_at').eq('path', path).maybeSingle();
      if (error) throw err(error);
      return data || null;
    }
    async function listRows(parent) {
      const out = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await sb.from(T).select('path,data').eq('parent', parent).order('path').range(from, from + PAGE - 1);
        if (error) throw err(error);
        out.push(...(data || []));
        if (!data || data.length < PAGE) break;
      }
      return out;
    }
    async function listPaths(paths) {
      if (!paths.length) return [];
      const { data, error } = await sb.from(T).select('path,data').in('path', paths);
      if (error) throw err(error);
      return data || [];
    }
    function docRef(path) {
      const segs = path.split('/');
      if (segs.length % 2 !== 0 || segs.some(s => !s)) throw new TypeError('Document paths need an even number of segments: ' + path);
      return {
        id: segs[segs.length - 1], path,
        async get() { const r = await getFull(path); return snapDoc(path, r && r.data); },
        async set(d) {
          const { data, error } = await sb.from(T).upsert({ path, parent: parentOf(path), data: d, updated_at: new Date().toISOString() }).select('path');
          if (error) throw err(error);
          if (!data || !data.length) throw denied();
          poke(parentOf(path));
        },
        // optimistic concurrency: only write if nobody changed the row since we read it; retry on conflict
        async update(d) {
          for (let attempt = 0; attempt < 5; attempt++) {
            const cur = await getFull(path);
            if (!cur) throw { code: 'invalid_argument', message: 'Document does not exist' };
            const { data, error } = await sb.from(T).update({ data: Object.assign({}, cur.data, d), updated_at: new Date().toISOString() })
              .eq('path', path).eq('updated_at', cur.updated_at).select('path');
            if (error) throw err(error);
            if (data && data.length) { poke(parentOf(path)); return; }
            const again = await getFull(path);
            if (again && again.updated_at === cur.updated_at) throw denied(); // row unchanged but write refused => blocked
            await new Promise(r => setTimeout(r, 80 + Math.random() * 200));
          }
          throw { code: 'unavailable', message: 'Too many simultaneous edits' };
        },
        async delete() {
          const { data, error } = await sb.from(T).delete().eq('path', path).select('path');
          if (error) throw err(error);
          if (!data || !data.length) { const still = await getFull(path); if (still) throw denied(); }
          poke(parentOf(path));
        },
        collection: c => collRef(path + '/' + c),
      };
    }
    function watch(parent, fetchRows, next, onErr) {
      let alive = true, busy = false, again = false, failures = 0, last = 0, prev = null;
      const run = async () => {
        if (!alive) return;
        if (busy) { again = true; return; }
        busy = true;
        try {
          const rows = await fetchRows(); const recovered = failures >= 2; failures = 0; last = Date.now();
          const sig = JSON.stringify(rows);
          if (alive && (sig !== prev || recovered)) { prev = sig; next(toSnap(rows)); }
        }
        catch (e) { failures++; if (failures === 2 && onErr && alive) onErr(e && e.code ? e : err(e)); }
        busy = false;
        if (again) { again = false; run(); }
      };
      if (!listeners.has(parent)) listeners.set(parent, new Set());
      listeners.get(parent).add(run);
      ensureChannel();
      run();
      // safety net: every 20s if realtime is down, every 90s if it is up
      const poll = setInterval(() => { if (!rtOk || failures || Date.now() - last > 90000) run(); }, 20000);
      const vis = () => { if (document.visibilityState === 'visible') run(); };
      document.addEventListener('visibilitychange', vis);
      const unsub = () => { alive = false; clearInterval(poll); document.removeEventListener('visibilitychange', vis); const s = listeners.get(parent); if (s) s.delete(run); };
      unsub.refresh = run;
      return unsub;
    }
    function collRef(cp) {
      const segs = cp.split('/');
      if (segs.length % 2 !== 1 || segs.some(s => !s)) throw new TypeError('Collection paths need an odd number of segments: ' + cp);
      return {
        path: cp,
        doc: id => docRef(cp + '/' + (id || ('d' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)))),
        async get() { return toSnap(await listRows(cp)); },
        onSnapshot(next, onErr) { return watch(cp, () => listRows(cp), next, onErr); },
        // only the listed ids (e.g. groups this browser knows about)
        subset(idsFn) { return { onSnapshot: (next, onErr) => watch(cp, () => listPaths(idsFn().map(id => cp + '/' + id)), next, onErr) }; },
      };
    }
    return { doc: docRef, collection: collRef };
  }
  function browserUser() {
    let id = null;
    try { id = localStorage.getItem('tally.uid'); if (!id) { id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); localStorage.setItem('tally.uid', id); } }
    catch (_) { id = 'b' + Math.random().toString(36).slice(2, 12); }
    return { id: async () => id, can: async () => true, isOwner: async () => false, profiles: async () => ({}) };
  }
  const api = { makeSupaDB, browserUser };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TallySupa = api;
})(typeof window !== 'undefined' ? window : this);
