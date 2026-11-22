// Textos y cálculos de equilibrio compartidos por la API y las notificaciones.

// Por debajo de este desvío (sobre el total) se considera que el reparto está equilibrado.
export const BALANCED = 0.1;

export function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

export function isBalanced(a, b) {
  const total = a + b;
  return total === 0 || Math.abs(a - b) / total <= BALANCED;
}

export function weeklyMessage(users, totals) {
  const [a, b] = users;
  const ta = totals[a.id] || 0;
  const tb = totals[b.id] || 0;
  const total = ta + tb;
  if (total === 0) return 'Todavía no se ha apuntado ninguna tarea.';
  const pa = Math.round((ta / total) * 100);
  const split = `${a.name} ${pa} % · ${b.name} ${100 - pa} %`;
  if (isBalanced(ta, tb)) return `${split}. Reparto equilibrado 👌`;
  const lead = ta > tb ? a : b;
  return `${split}. ${lead.name} ha dedicado ${fmtDur(Math.abs(ta - tb))} más.`;
}
