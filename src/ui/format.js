// Small amounts read better in cents: "0,3 ¢" rather than "$0.0030".
export function money(x) {
  if (x < 0.01) return `${(x * 100).toLocaleString("es-ES", { maximumFractionDigits: 1 })} ¢`;
  return `$${x.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const num = (x) => Math.round(x).toLocaleString("es-ES");
