export function makeConfig(env = {}) {
  const n = (v, d) => (v === undefined || v === '' || Number.isNaN(+v) ? d : +v);
  return {
    // https-адрес мини-аппки, без слэша на конце. Если не задан, берём адрес, по которому открыли Worker.
    webappUrl: String(env.WEBAPP_URL || '').replace(/\/$/, ''),
    // Можно перечислить несколько адресов через запятую: сначала основной, затем мосты.
    tgBases: String(env.TG_API_BASES || 'https://api.telegram.org').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean),
    operator: {
      name: env.OPERATOR_NAME || '',
      inn: env.OPERATOR_INN || '',
      contact: env.OPERATOR_CONTACT || '',
      hosting: env.HOSTING_NAME || ''
    },
    policyDraft: env.POLICY_DRAFT !== '0',
    // Сводка по умолчанию: воскресенье 18:00 по Москве (смещение +3).
    digest: { dow: n(env.DIGEST_DOW, 0), hour: n(env.DIGEST_HOUR, 18), tzOffset: n(env.DIGEST_TZ_OFFSET, 3) },
    initDataMaxAge: n(env.INITDATA_MAX_AGE, 86400),
    maxItems: 60,
    maxBought: 200
  };
}
