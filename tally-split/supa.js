// Supabase-backed store with the same small API the page uses (doc/collection, get/set/update/delete, onSnapshot).
// Table: public.docs(path text pk, parent text, data jsonb, updated_at timestamptz)
(function (root) {
  'use strict';
  function makeSupaDB(sb) {
    const T = 'docs';
    const parentOf = p => p.split('/').slice(0, -1).join('/');
    const err = (e) => {
      const msg = (e && e.message) || String(e);
      const code = e && (e.code === '42501' || /row-level security|permission/i.test(msg)) ? 'invalid_argument' : 'unavailable';
      return { code, message: msg };
    };
    const snapDoc = (path, data) => ({ id: path.split('/').pop(), exists: !!data, data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined), metadata: { fromCache: false, hasPendingWrites: false } });
    const listeners = new Map(); // parent -> Set(refetch)
    const poke = (parent) => { const s = listeners.get(parent); if (s) s.forEach(f => f()); };
    let channel = null;
    function ensureChannel() {
      if (channel) return;
      channel = sb.channel('docs-all')
        .on('postgres_changes', { event: '*', schema: 'public', table: T }, payload => {
          const row = payload.new && payload.new.parent != null ? payload.new : payload.old;
          if (row && row.parent != null) poke(row.parent);
          else if (row && row.path) poke(parentOf(row.path));
          else listeners.forEach(s => s.forEach(f => f()));
        })
        .subscribe();
    }
    async function getRow(path) {
      const { data, error } = await sb.from(T).select('data').eq('path', path).maybeSingle();
      if (error) throw err(error);
      return data ? data.data : null;
    }
    async function listRows(parent) {
      const { data, error } = await sb.from(T).select('path,data').eq('parent', parent).order('path').limit(5000);
      if (error) throw err(error);
      return data || [];
    }
    function docRef(path) {
      const segs = path.split('/');
      if (segs.length % 2 !== 0 || segs.some(s => !s)) throw new TypeError('Document paths need an even number of segments: ' + path);
      return {
        id: segs[segs.length - 1], path,
        async get() { return snapDoc(path, await getRow(path)); },
        async set(d) {
          const { error } = await sb.from(T).upsert({ path, parent: parentOf(path), data: d, updated_at: new Date().toISOString() });
          if (error) throw err(error);
          poke(parentOf(path));
        },
        async update(d) {
          const cur = await getRow(path);
          if (!cur) throw { code: 'invalid_argument', message: 'Document does not exist' };
          const { error } = await sb.from(T).update({ data: Object.assign({}, cur, d), updated_at: new Date().toISOString() }).eq('path', path);
          if (error) throw err(error);
          poke(parentOf(path));
        },
        async delete() {
          const { error } = await sb.from(T).delete().eq('path', path);
          if (error) throw err(error);
          poke(parentOf(path));
        },
        collection: c => collRef(path + '/' + c),
      };
    }
    function collRef(cp) {
      const segs = cp.split('/');
      if (segs.length % 2 !== 1 || segs.some(s => !s)) throw new TypeError('Collection paths need an odd number of segments: ' + cp);
      const toSnap = rows => { const docs = rows.map(r => snapDoc(r.path, r.data)); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } }; };
      return {
        path: cp,
        doc: id => docRef(cp + '/' + (id || ('d' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)))),
        async get() { return toSnap(await listRows(cp)); },
        onSnapshot(next, onErr) {
          let alive = true, busy = false, again = false, failures = 0;
          const run = async () => {
            if (!alive) return;
            if (busy) { again = true; return; }
            busy = true;
            try { const rows = await listRows(cp); failures = 0; if (alive) next(toSnap(rows)); }
            catch (e) { failures++; if (failures === 3 && onErr && alive) { alive = false; onErr(e && e.code ? e : err(e)); } }
            busy = false;
            if (again) { again = false; run(); }
          };
          if (!listeners.has(cp)) listeners.set(cp, new Set());
          listeners.get(cp).add(run);
          ensureChannel();
          run();
          const poll = setInterval(run, 20000); // safety net if realtime is off
          const vis = () => { if (document.visibilityState === 'visible') run(); };
          document.addEventListener('visibilitychange', vis);
          return () => { alive = false; clearInterval(poll); document.removeEventListener('visibilitychange', vis); const s = listeners.get(cp); if (s) s.delete(run); };
        },
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
