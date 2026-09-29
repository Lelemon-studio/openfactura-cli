import { ValidationError } from "../command.ts";
import type { Linea } from "./totales.ts";

export const MAX_NOMBRE_ITEM = 80;
export const MAX_DECIMALES = 6;
export const MAX_MONTO = 999_999_999_999;
const GUIONES_LARGOS = /[‒–—―−]/g;
const CAMPOS_JSON = new Set(["nombre", "cantidad", "precio", "exento", "descripcion"]);

const FORMATO =
  'Cada --item va como "nombre|cantidad|precio" (agrega "|exento" si corresponde) o como JSON: ' +
  '{"nombre":"...","cantidad":1,"precio":1000,"exento":false,"descripcion":"..."}';

export function numeroEstricto(valor: unknown, campo: string, prefijo: string): number {
  let n: number;
  if (typeof valor === "number") {
    n = valor;
  } else if (typeof valor === "string") {
    const t = valor.trim();
    if (/^[1-9]\d{0,2}([.,]\d{3})+$/.test(t)) {
      throw new ValidationError(
        `${prefijo}: ${campo} "${valor}" es ambiguo. Escribe el número sin separador de miles: ${t.replace(/[.,]/g, "")}`,
      );
    }
    if (!/^\d+([.,]\d+)?$/.test(t)) throw new ValidationError(`${prefijo}: ${campo} "${valor}" no es un número. ${FORMATO}`);
    n = Number(t.replace(",", "."));
  } else {
    throw new ValidationError(`${prefijo}: falta ${campo}. ${FORMATO}`);
  }
  if (!Number.isFinite(n) || n < 0) throw new ValidationError(`${prefijo}: ${campo} "${valor}" no es un número válido`);
  const decimales = (String(n).split(".")[1] ?? "").length;
  if (decimales > MAX_DECIMALES || String(n).includes("e")) {
    throw new ValidationError(`${prefijo}: ${campo} admite hasta ${MAX_DECIMALES} decimales y un tamaño razonable`);
  }
  if (n > MAX_MONTO) throw new ValidationError(`${prefijo}: ${campo} ${valor} es demasiado grande`);
  return n;
}

function limpiarNombre(nombre: string, i: number, avisos: string[]): string {
  const sinGuiones = nombre.replace(GUIONES_LARGOS, "-");
  if (sinGuiones !== nombre) avisos.push(`Ítem ${i}: se cambió el guion largo por uno corto, porque OpenFactura lo borra`);
  const limpio = sinGuiones.replace(/\s{2,}/g, " ").trim();
  if (!limpio) throw new ValidationError(`Ítem ${i}: falta el nombre. ${FORMATO}`);
  if (limpio.length > MAX_NOMBRE_ITEM) {
    throw new ValidationError(
      `Ítem ${i}: el nombre tiene ${limpio.length} caracteres y el máximo es ${MAX_NOMBRE_ITEM}. Pon el detalle en "descripcion"`,
    );
  }
  return limpio;
}

export function parsearItem(texto: string, i: number, avisos: string[]): Linea {
  const t = texto.trim();
  const prefijo = `Ítem ${i}`;
  if (t.startsWith("{")) {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(t);
    } catch {
      throw new ValidationError(`${prefijo}: el JSON no es válido. ${FORMATO}`);
    }
    const desconocidos = Object.keys(o).filter((k) => !CAMPOS_JSON.has(k));
    if (desconocidos.length) {
      throw new ValidationError(`${prefijo}: campos desconocidos ${desconocidos.join(", ")}. Los válidos son ${[...CAMPOS_JSON].join(", ")}`);
    }
    if (o.exento !== undefined && typeof o.exento !== "boolean") throw new ValidationError(`${prefijo}: "exento" debe ser true o false, sin comillas`);
    if (o.descripcion !== undefined && typeof o.descripcion !== "string") throw new ValidationError(`${prefijo}: "descripcion" debe ser texto`);
    const linea: Linea = {
      nombre: limpiarNombre(String(o.nombre ?? ""), i, avisos),
      cantidad: numeroEstricto(o.cantidad ?? 1, "la cantidad", prefijo),
      precio: numeroEstricto(o.precio, "el precio", prefijo),
      exento: o.exento === true,
    };
    if (typeof o.descripcion === "string" && o.descripcion.trim()) linea.descripcion = o.descripcion.trim();
    return linea;
  }

  const partes = t.split("|").map((p) => p.trim());
  if (partes.length < 3 || partes.length > 4) throw new ValidationError(`${prefijo}: "${texto}" no tiene el formato esperado. ${FORMATO}`);
  const [nombre, cantidad, precio, marca] = partes as [string, string, string, string | undefined];
  if (marca !== undefined && marca.toLowerCase() !== "exento") {
    throw new ValidationError(`${prefijo}: el cuarto campo sólo puede ser "exento". ${FORMATO}`);
  }
  return {
    nombre: limpiarNombre(nombre, i, avisos),
    cantidad: numeroEstricto(cantidad, "la cantidad", prefijo),
    precio: numeroEstricto(precio, "el precio", prefijo),
    exento: marca !== undefined,
  };
}
