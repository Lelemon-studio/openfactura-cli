import { UsageError } from "./command.ts";

export function fecha(valor: string, nombre: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor);
  if (!m) throw new UsageError(`--${nombre} debe ser AAAA-MM-DD, llegó "${valor}"`);
  const d = new Date(`${valor}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== valor) {
    throw new UsageError(`--${nombre}: "${valor}" no es una fecha que exista`);
  }
  if (Number(m[1]) < 2000 || Number(m[1]) > 2100) throw new UsageError(`--${nombre}: el año ${m[1]} está fuera de rango`);
  return valor;
}

export function hoy(ahora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora);
}

export interface Periodo {
  anio: string;
  mes: string;
  dia?: string;
}

export function periodo(valor: string): Periodo {
  const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(valor);
  if (!m) throw new UsageError(`El período debe ser AAAA-MM o AAAA-MM-DD, llegó "${valor}"`);
  const mes = m[2]!.padStart(2, "0");
  if (Number(mes) < 1 || Number(mes) > 12) throw new UsageError(`Mes inválido en "${valor}"`);
  const resultado: Periodo = { anio: m[1]!, mes };
  if (m[3] !== undefined) {
    resultado.dia = m[3].padStart(2, "0");
    fecha(`${resultado.anio}-${mes}-${resultado.dia}`, "periodo");
  }
  return resultado;
}

export function rutaPeriodo(p: Periodo): string {
  return `${p.anio}/${p.mes}${p.dia ? `/${p.dia}` : ""}`;
}
