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
