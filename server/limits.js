/** Простой счётчик «не больше max за окно». Память чистится сама. */
export function makeLimiter(max, windowMs) {
  const m = new Map();
  return function hit(key) {
    const now = Date.now();
    let e = m.get(key);
    if (!e || now - e.t > windowMs) { e = { t: now, n: 0 }; m.set(key, e); }
    e.n++;
    if (m.size > 5000) for (const [k, v] of m) if (now - v.t > windowMs) m.delete(k);
    return e.n <= max;
  };
}

/**
 * Лимит «не больше max за окно». Если у Worker есть лимитер Cloudflare (binding), считает он:
 * счётчик общий для всех экземпляров в одной точке присутствия. Нет binding (тесты, локально)
 * или он ответил ошибкой: падаем на счётчик в памяти, чтобы сервис не вставал из-за лимитера.
 */
export function makeGate(binding, max, windowMs) {
  const local = makeLimiter(max, windowMs);
  return async function gate(key) {
    if (binding && typeof binding.limit === 'function') {
      try { return (await binding.limit({ key: String(key) })).success; } catch { /* упал лимитер: считаем сами */ }
    }
    return local(key);
  };
}
