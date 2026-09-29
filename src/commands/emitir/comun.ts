import { type Contexto, UsageError, texto } from "../../command.ts";
import { type Linea, type Modo, TASA_IVA } from "../../dte/totales.ts";

export type Obj = Record<string, any>;

export interface Tipo {
  codigo: number;
  modo: Modo;
  boleta: boolean;
  receptor: "obligatorio" | "opcional";
  nota: boolean;
  guia: boolean;
}

export const TIPOS: Record<string, Tipo> = {
  factura: { codigo: 33, modo: "neto", boleta: false, receptor: "obligatorio", nota: false, guia: false },
  "factura-exenta": { codigo: 34, modo: "exento", boleta: false, receptor: "obligatorio", nota: false, guia: false },
  boleta: { codigo: 39, modo: "bruto", boleta: true, receptor: "opcional", nota: false, guia: false },
  "boleta-exenta": { codigo: 41, modo: "exento", boleta: true, receptor: "opcional", nota: false, guia: false },
  "nota-credito": { codigo: 61, modo: "neto", boleta: false, receptor: "opcional", nota: true, guia: false },
  "nota-debito": { codigo: 56, modo: "neto", boleta: false, receptor: "opcional", nota: true, guia: false },
  guia: { codigo: 52, modo: "neto", boleta: false, receptor: "obligatorio", nota: false, guia: true },
};

export const REFERENCIABLES: Record<number, number[]> = {
  61: [33, 34, 39, 41, 43, 46, 56],
  56: [33, 34, 43, 46, 61],
};
export const TIPOS_BOLETA = new Set([39, 41]);
export const TIPOS_EXENTOS = new Set([34, 41]);

export const FORMA_PAGO: Record<string, number> = { contado: 1, credito: 2, "sin-costo": 3 };
export const MEDIO_PAGO_BOLETA: Record<string, number> = { efectivo: 1, electronico: 2, transferencia: 3, cheque: 4, otro: 5 };
export const TRASLADO: Record<string, number> = {
  venta: 1,
  "venta-por-efectuar": 2,
  consignacion: 3,
  "entrega-gratuita": 4,
  interno: 5,
  "otro-traslado": 6,
  devolucion: 7,
  "traslado-exportacion": 8,
  "venta-exportacion": 9,
};
export const DESPACHO: Record<string, number> = { receptor: 1, "emisor-cliente": 2, "emisor-otro": 3 };
export const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const VIGENCIA_RES_154 = "2026-11-01";
export const UMBRAL_BOLETA_IDENTIFICADA = 5_000_000;
export const MESES_PLAZO_REBAJA = 6;
export const MAX_ESPERA_S = 3600;
export const MAX_PAGINAS_NOTAS = 10;

export function opcion(mapa: Record<string, number>, valor: string | undefined, flag: string): number | undefined {
  if (valor === undefined) return undefined;
  const v = mapa[valor.toLowerCase()];
  if (v === undefined) throw new UsageError(`--${flag}: "${valor}" no existe. Usa ${Object.keys(mapa).join(", ")}`);
  return v;
}

export function correo(ctx: Contexto): string | undefined {
  const c = texto(ctx.flags, "correo");
  if (c !== undefined && !CORREO.test(c)) throw new UsageError(`--correo: "${c}" no parece un correo`);
  return c;
}

export function lista(ctx: Contexto, nombre: string): string[] {
  return (ctx.flags[nombre] as string[] | undefined) ?? [];
}

export function detalle(lineas: Array<Linea & { monto: number }>): Obj[] {
  return lineas.map((l, i) => ({
    NroLinDet: i + 1,
    NmbItem: l.nombre,
    ...(l.descripcion ? { DscItem: l.descripcion } : {}),
    QtyItem: l.cantidad,
    ...(l.precio > 0 ? { PrcItem: l.precio } : {}),
    MontoItem: l.monto,
    ...(l.exento ? { IndExe: 1 } : {}),
  }));
}

export function numeros(t: Obj): Obj {
  const r: Obj = {};
  for (const k of ["MntNeto", "MntExe", "IVA", "MntTotal"]) if (t[k] !== undefined && t[k] !== null && t[k] !== "") r[k] = Number(t[k]);
  return r;
}

export function totalesDte(totales: Obj, tipo: Tipo, modo: Modo): Obj {
  const t = numeros(totales);
  if (modo === "exento") return { MntExe: t.MntExe ?? t.MntTotal ?? 0, MntTotal: t.MntTotal ?? 0 };
  if (tipo.boleta) return t;
  return { MntNeto: t.MntNeto ?? 0, ...(t.MntExe ? { MntExe: t.MntExe } : {}), TasaIVA: TASA_IVA, IVA: t.IVA ?? 0, MntTotal: t.MntTotal ?? 0 };
}
