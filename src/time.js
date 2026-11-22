// Límites de periodos en la zona horaria del proceso (TZ). La semana empieza en lunes.

export function bounds(kind, offset = 0, now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);

  if (kind === 'day') {
    d.setDate(d.getDate() + offset);
    const from = d.getTime();
    d.setDate(d.getDate() + 1);
    return { from, to: d.getTime() };
  }
  if (kind === 'week') {
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
    const from = d.getTime();
    d.setDate(d.getDate() + 7);
    return { from, to: d.getTime() };
  }
  if (kind === 'month') {
    d.setDate(1);
    d.setMonth(d.getMonth() + offset);
    const from = d.getTime();
    d.setMonth(d.getMonth() + 1);
    return { from, to: d.getTime() };
  }
  if (kind === 'year') {
    d.setMonth(0, 1);
    d.setFullYear(d.getFullYear() + offset);
    const from = d.getTime();
    d.setFullYear(d.getFullYear() + 1);
    return { from, to: d.getTime() };
  }
  if (kind === 'all') return { from: 0, to: 8.64e15 };
  throw new Error(`Periodo desconocido: ${kind}`);
}

const pad = (n) => String(n).padStart(2, '0');

// 'AAAA-MM-DD' en hora local.
export const dayStr = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Mediodía local de un día 'AAAA-MM-DD', o null si no es una fecha válida.
export function noonOf(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!m) return null;
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(y, mo - 1, da, 12, 0, 0, 0);
  return d.getFullYear() === y && d.getMonth() === mo - 1 && d.getDate() === da ? d.getTime() : null;
}
