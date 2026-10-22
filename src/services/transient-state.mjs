// Estado provisório por instância. Não é compartilhado entre funções/containers.
// Substituir esta camada por armazenamento compartilhado na etapa Supabase.
export function createTransientState({ now = () => Date.now(), maxSessions = 1000, maxIds = 10000 } = {}) {
  const sessions = new Map(), ids = new Map(), locks = new Map(), rates = new Map();
  function trim(map, maximum) {
    while (map.size > maximum) map.delete(map.keys().next().value);
  }
  function prune() {
    const timestamp = now();
    for (const [key, value] of sessions) if (value.updated + 86400000 <= timestamp && !locks.has(key)) sessions.delete(key);
    for (const [key, value] of ids) if (value.updated + 7 * 86400000 <= timestamp && value.state !== 'processing') ids.delete(key);
    for (const [key, value] of rates) if (value.resetAt <= timestamp) rates.delete(key);
  }
  return {
    persistent: false,
    getHistory(key) { prune(); return sessions.get(key)?.history || []; },
    saveHistory(key, history) {
      sessions.set(key, { history: history.slice(-20), updated: now() });
      trim(sessions, maxSessions);
    },
    getMessage(id) { prune(); return ids.get(id); },
    setMessage(id, state) { ids.set(id, { state, updated: now() }); trim(ids, maxIds); },
    allowRate(key, limit = 15, windowMs = 60000) {
      prune();
      const timestamp = now();
      const entry = rates.get(key);
      if (!entry || entry.resetAt <= timestamp) {
        rates.set(key, { count: 1, resetAt: timestamp + windowMs });
        trim(rates, maxSessions);
        return true;
      }
      if (entry.count >= limit) return false;
      entry.count += 1;
      return true;
    },
    async serial(key, work) {
      const previous = locks.get(key) || Promise.resolve();
      const next = previous.catch(() => {}).then(work);
      locks.set(key, next);
      try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
    },
  };
}
