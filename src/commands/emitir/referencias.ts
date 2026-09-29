import { ApiError } from "../../client.ts";
import { type Contexto, UsageError, ValidationError, entero, texto } from "../../command.ts";
import { fecha } from "../../fechas.ts";
import { normalizarRut } from "../../rut.ts";
import { type Modo, TASA_IVA } from "../../dte/totales.ts";
import { LARGOS } from "../../dte/esquema.ts";
import { MAX_PAGINAS_NOTAS, type Obj, REFERENCIABLES, TIPOS_BOLETA, type Tipo, lista, numeros } from "./comun.ts";

export function restarMeses(fechaIso: string, meses: number): string {
  const [a, m, d] = fechaIso.split("-").map(Number) as [number, number, number];
  const total = a * 12 + (m - 1) - meses;
  const anio = Math.floor(total / 12);
  const mes = (total % 12) + 1;
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${anio}-${String(mes).padStart(2, "0")}-${String(Math.min(d, ultimo)).padStart(2, "0")}`;
}

export function totalesOriginales(totales: Obj | undefined, modo: Modo): Obj {
  if (!totales || typeof totales !== "object") throw new ValidationError("El documento original no trae totales");
  const t: Obj = {};
  for (const k of ["MntNeto", "MntExe", "IVA", "MntTotal"]) {
    if (totales[k] === undefined || totales[k] === null || totales[k] === "") continue;
    const n = typeof totales[k] === "number" ? totales[k] : /^\d+$/.test(String(totales[k]).trim()) ? Number(totales[k]) : NaN;
    if (!Number.isFinite(n)) throw new ValidationError(`El documento original trae ${k} = "${totales[k]}", que no es un monto`);
    t[k] = n;
  }
  if (t.MntTotal === undefined) throw new ValidationError("El documento original no trae MntTotal");
  if (modo === "bruto" && (t.MntNeto === undefined || t.IVA === undefined)) {
    const afecto = t.MntTotal - (t.MntExe ?? 0);
    t.MntNeto = Math.round(afecto / (1 + TASA_IVA / 100));
    t.IVA = afecto - t.MntNeto;
  }
  return t;
}

export interface Referencia {
  tipo: number;
  folio: number;
  codRef: 1 | 2 | 3;
  razon: string;
  original: Obj;
  fecha: string;
}

export async function referenciaNota(ctx: Contexto, tipo: Tipo, rutPropio: string): Promise<Referencia> {
  const ref = texto(ctx.flags, "referencia");
  if (!ref) throw new UsageError('Falta --referencia <tipo>:<folio> del documento que se corrige, por ejemplo "33:30"');
  const m = /^(\d+):(\d+)$/.exec(ref.trim());
  if (!m) throw new UsageError(`--referencia debe ser <tipo>:<folio>, llegó "${ref}"`);
  const tipoRef = Number(m[1]);
  const folio = Number(m[2]);

  if (tipo.codigo === 56 && TIPOS_BOLETA.has(tipoRef)) {
    throw new ValidationError(
      "No se emite nota de débito sobre una boleta. Para cobrar más sobre una boleta se emite una boleta nueva que referencia a la primera (Res. Ex. SII 74/2020)",
    );
  }
  if (tipo.codigo === 61 && tipoRef === 61) {
    throw new ValidationError("Una nota de crédito no se revierte con otra nota de crédito: corresponde una nota de débito que la referencie");
  }
  if (!REFERENCIABLES[tipo.codigo]!.includes(tipoRef)) {
    throw new ValidationError(
      `Una ${tipo.codigo === 61 ? "nota de crédito" : "nota de débito"} no puede referenciar un documento tipo ${tipoRef}. Tipos válidos: ${REFERENCIABLES[tipo.codigo]!.join(", ")}`,
    );
  }

  const acciones = [ctx.flags.anula && 1, ctx.flags["corrige-texto"] && 2, ctx.flags["corrige-montos"] && 3].filter(Boolean) as Array<1 | 2 | 3>;
  if (acciones.length !== 1) throw new UsageError("Indica exactamente una: --anula, --corrige-montos o --corrige-texto");
  const codRef = acciones[0]!;
  if (tipo.codigo === 56 && codRef === 1 && tipoRef !== 61) {
    throw new ValidationError("Una nota de débito sólo anula una nota de crédito. Para dejar sin efecto una factura se emite una nota de crédito con --anula");
  }
  const razonDada = texto(ctx.flags, "razon");
  if (codRef === 2 && !razonDada) throw new UsageError("--corrige-texto necesita --razon con la corrección");
  const razon = razonDada ?? (codRef === 1 ? "Anula documento" : "Corrige montos");
  if (razon.length > LARGOS.RazonRef) throw new ValidationError(`--razon tiene ${razon.length} caracteres y el máximo es ${LARGOS.RazonRef}`);
  if (codRef === 2 && razon.length > LARGOS.NmbItem) {
    throw new ValidationError(`Con --corrige-texto la razón va también como línea del detalle, que admite ${LARGOS.NmbItem} caracteres`);
  }

  const r = await leerDocumento(ctx, rutPropio, tipoRef, folio);
  const original = r?.json;
  if (!original?.Encabezado) throw new ValidationError(`No se pudo leer el documento ${tipoRef} folio ${folio} para referenciarlo`);
  const emisorOriginal = original.Encabezado.Emisor?.RUTEmisor;
  if (emisorOriginal && normalizarRut(String(emisorOriginal)) !== rutPropio) {
    throw new ValidationError(`El documento ${tipoRef} folio ${folio} es de otro emisor (${emisorOriginal}). Sólo se corrigen documentos propios`);
  }
  if (!original.Encabezado.Receptor?.RUTRecep) {
    throw new ValidationError(`El documento ${tipoRef} folio ${folio} no trae el RUT del receptor, y la nota tiene que ir al mismo receptor`);
  }
  const fechaOriginal = String(original.Encabezado.IdDoc?.FchEmis ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaOriginal)) throw new ValidationError(`El documento ${tipoRef} folio ${folio} no trae fecha de emisión`);
  return { tipo: tipoRef, folio, codRef, razon, original, fecha: fechaOriginal };
}

export async function leerDocumento(ctx: Contexto, rutPropio: string, tipo: number, folio: number | string): Promise<Obj | null> {
  try {
    return (await ctx.client.get(`/document/${rutPropio}/${tipo}/${folio}/json`)) as Obj | null;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    throw new ApiError(`No se pudo leer el documento ${tipo} folio ${folio}: ${e.message}`, e.status, e.code, e.details);
  }
}

export function receptorDeNota(ctx: Contexto, ref: Referencia, email: string | undefined): Obj {
  const original = { ...(ref.original.Encabezado.Receptor ?? {}) } as Obj;
  const dado = texto(ctx.flags, "receptor");
  if (dado && normalizarRut(dado) !== normalizarRut(String(original.RUTRecep ?? ""))) {
    throw new ValidationError(
      `El receptor de la nota tiene que ser el mismo del documento que corrige (${original.RUTRecep}). ` +
        "Si el RUT del original estaba mal, se anula con --anula y se emite un documento nuevo al RUT correcto",
    );
  }
  const reemplazos: Obj = {
    RznSocRecep: texto(ctx.flags, "razon-social"),
    GiroRecep: texto(ctx.flags, "giro"),
    DirRecep: texto(ctx.flags, "direccion"),
    CmnaRecep: texto(ctx.flags, "comuna"),
    Contacto: texto(ctx.flags, "contacto"),
    CorreoRecep: email,
  };
  for (const [k, v] of Object.entries(reemplazos)) if (v !== undefined) original[k] = v;
  return original;
}

export async function referenciasLibres(ctx: Contexto, rutPropio: string): Promise<Obj[]> {
  const refs = lista(ctx, "ref");
  const salida: Obj[] = [];
  for (const [i, ref] of refs.entries()) {
    const m = /^(\d+):([^:]+)(?::(\d{4}-\d{2}-\d{2}))?$/.exec(ref.trim());
    if (!m) throw new UsageError(`--ref debe ser <tipo>:<folio>[:AAAA-MM-DD], llegó "${ref}"`);
    const tipo = Number(m[1]);
    const tributario = tipo < 800;
    const folio: number | string = tributario ? entero(m[2], "el folio de --ref") : m[2]!;
    let fechaRef = m[3];
    if (!fechaRef) {
      if (!tributario) throw new UsageError(`--ref ${ref}: un documento tipo ${tipo} necesita la fecha, ej. ${tipo}:${folio}:AAAA-MM-DD`);
      const r = await leerDocumento(ctx, rutPropio, tipo, folio);
      fechaRef = r?.json?.Encabezado?.IdDoc?.FchEmis;
      if (!fechaRef) throw new ValidationError(`No se encontró el documento ${tipo} folio ${folio}. Pasa la fecha: ${tipo}:${folio}:AAAA-MM-DD`);
    }
    salida.push({ NroLinRef: i + 1, TpoDocRef: String(tipo), FolioRef: folio, FchRef: fecha(fechaRef, "ref") });
  }
  return salida;
}

export async function notasPrevias(
  ctx: Contexto,
  ref: Referencia,
  rutPropio: string,
  receptor: Obj,
  avisos: string[],
): Promise<{ suma: Obj; folios: string[] } | null> {
  try {
    const suma: Obj = {};
    const folios: string[] = [];
    const filtros: Obj = { TipoDTE: { eq: 61 }, FchEmis: { gte: ref.fecha } };
    const rutRecep = Number(normalizarRut(String(receptor.RUTRecep)).split("-")[0]);
    if (rutRecep !== 66666666) filtros.RUTRecep = { eq: rutRecep };
    for (let pagina = 1; pagina <= MAX_PAGINAS_NOTAS; pagina++) {
      const r = (await ctx.client.post("/document/issued", pagina > 1 ? { ...filtros, Page: pagina } : filtros)) as Obj | null;
      for (const d of r?.data ?? []) {
        const nc = (await ctx.client.get(`/document/${rutPropio}/61/${d.Folio}/json`)) as Obj | null;
        const refs = nc?.json?.Referencia;
        const lista = Array.isArray(refs) ? refs : refs ? [refs] : [];
        const apunta = lista.some((x: Obj) => String(x.TpoDocRef) === String(ref.tipo) && Number(x.FolioRef) === ref.folio && Number(x.CodRef) !== 2);
        if (!apunta) continue;
        folios.push(`61:${d.Folio}`);
        const t = numeros(nc!.json.Encabezado?.Totales ?? {});
        for (const k of ["MntNeto", "MntExe", "IVA", "MntTotal"]) suma[k] = (suma[k] ?? 0) + (t[k] ?? 0);
      }
      if (!r || pagina >= Number(r.last_page ?? pagina)) break;
      if (pagina === MAX_PAGINAS_NOTAS) {
        avisos.push(
          `Hay más de ${MAX_PAGINAS_NOTAS} páginas de notas de crédito desde la fecha del original y sólo se revisaron ${MAX_PAGINAS_NOTAS}: la suma de notas previas puede estar incompleta. Revísalo con: openfactura emitidos --tipo 61`,
        );
      }
    }
    return { suma, folios };
  } catch (e) {
    avisos.push(
      `No se pudo revisar si ya hay otras notas de crédito contra este documento (${(e as Error).message}). Revísalo con: openfactura emitidos --tipo 61`,
    );
    return null;
  }
}
