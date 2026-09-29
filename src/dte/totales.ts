import { ValidationError } from "../command.ts";

export const TASA_IVA = 19;
const MAX_MONTO_DOCUMENTO = 999_999_999_999_999;
const FACTOR = 1 + TASA_IVA / 100;

export type Modo = "neto" | "bruto" | "exento";

export interface Linea {
  nombre: string;
  cantidad: number;
  precio: number;
  exento: boolean;
  descripcion?: string;
}

export interface LineaCalculada extends Linea {
  monto: number;
}

export interface Totales {
  MntNeto?: number;
  MntExe?: number;
  IVA?: number;
  MntTotal: number;
}

export interface Opciones {
  preciosConIva?: boolean;
  permitirCero?: boolean;
}

export interface Calculo {
  lineas: LineaCalculada[];
  totales: Totales;
  avisos: string[];
}

function validar(lineas: Linea[]) {
  if (lineas.length === 0) throw new ValidationError("El documento necesita al menos una línea de detalle (--item)");
  lineas.forEach((l, i) => {
    if (!(l.cantidad > 0)) throw new ValidationError(`Línea ${i + 1}: la cantidad debe ser mayor que cero`);
    if (!(l.precio >= 0) || !Number.isFinite(l.precio)) throw new ValidationError(`Línea ${i + 1}: el precio no puede ser negativo`);
  });
}

const suma = (ls: LineaCalculada[]) => ls.reduce((n, l) => n + l.monto, 0);

export function calcularTotales(modo: Modo, entrada: Linea[], opciones: Opciones = {}): Calculo {
  validar(entrada);
  const avisos: string[] = [];

  const base = entrada.map((l) => {
    const exento = modo === "exento" ? true : l.exento;
    const precio = modo === "neto" && opciones.preciosConIva && !exento ? Math.round((l.precio / FACTOR) * 1e6) / 1e6 : l.precio;
    return { ...l, exento, precio };
  });
  const lineas: LineaCalculada[] = base.map((l) => ({ ...l, monto: Math.round(l.cantidad * l.precio) }));
  lineas.forEach((l, i) => {
    if (!Number.isSafeInteger(l.monto) || l.monto > MAX_MONTO_DOCUMENTO) {
      throw new ValidationError(`Línea ${i + 1}: el monto (cantidad por precio) es demasiado grande`);
    }
  });

  const exentas = suma(lineas.filter((l) => l.exento));
  const afectas = suma(lineas.filter((l) => !l.exento));
  let totales: Totales;

  if (modo === "exento") {
    totales = { MntExe: exentas, MntTotal: exentas };
  } else if (modo === "bruto") {
    const neto = Math.round(afectas / FACTOR);
    totales = { MntNeto: neto, ...(exentas ? { MntExe: exentas } : {}), IVA: afectas - neto, MntTotal: afectas + exentas };
  } else {
    const iva = Math.round(afectas * (TASA_IVA / 100));
    totales = { MntNeto: afectas, ...(exentas ? { MntExe: exentas } : {}), IVA: iva, MntTotal: afectas + exentas + iva };
    if (opciones.preciosConIva) {
      const pedido = Math.round(entrada.reduce((n, l) => n + l.cantidad * l.precio, 0));
      if (pedido !== totales.MntTotal) {
        avisos.push(
          `Los precios con IVA suman ${pedido}, pero al desglosarlos el total queda en ${totales.MntTotal}. ` +
            "El SII calcula el IVA sobre el neto, así que no todo precio bruto tiene un neto exacto.",
        );
      }
    }
  }

  if (!Number.isSafeInteger(totales.MntTotal) || totales.MntTotal > MAX_MONTO_DOCUMENTO) {
    throw new ValidationError("El total del documento es demasiado grande");
  }
  if (totales.MntTotal === 0 && !opciones.permitirCero) {
    throw new ValidationError("El total del documento es cero. Revisa los precios de los ítems");
  }
  return { lineas, totales, avisos };
}
