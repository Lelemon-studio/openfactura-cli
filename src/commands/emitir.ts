import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ApiError } from "../client.ts";
import { type Comando, type Contexto, UsageError, ValidationError, arg, texto } from "../command.ts";
import { fecha, hoy } from "../fechas.ts";
import { normalizarRut } from "../rut.ts";
import { parsearItem } from "../dte/items.ts";
import { emisorDesdeOrganizacion, RECEPTOR_CONSUMIDOR_FINAL, receptorDesdeFicha } from "../dte/partes.ts";
import { calcularTotales, type Linea, type Modo, TASA_IVA } from "../dte/totales.ts";
import { ordenarDte, validarContraEsquema } from "../dte/esquema.ts";
import { entero } from "./lecturas.ts";

type Obj = Record<string, any>;

interface Tipo {
  codigo: number;
  modo: Modo;
  boleta: boolean;
  receptor: "obligatorio" | "opcional";
  nota: boolean;
  guia: boolean;
}

const TIPOS: Record<string, Tipo> = {
  factura: { codigo: 33, modo: "neto", boleta: false, receptor: "obligatorio", nota: false, guia: false },
  "factura-exenta": { codigo: 34, modo: "exento", boleta: false, receptor: "obligatorio", nota: false, guia: false },
  boleta: { codigo: 39, modo: "bruto", boleta: true, receptor: "opcional", nota: false, guia: false },
  "boleta-exenta": { codigo: 41, modo: "exento", boleta: true, receptor: "opcional", nota: false, guia: false },
  "nota-credito": { codigo: 61, modo: "neto", boleta: false, receptor: "opcional", nota: true, guia: false },
  "nota-debito": { codigo: 56, modo: "neto", boleta: false, receptor: "opcional", nota: true, guia: false },
  guia: { codigo: 52, modo: "neto", boleta: false, receptor: "obligatorio", nota: false, guia: true },
};

const REFERENCIABLES: Record<number, number[]> = {
  61: [33, 34, 39, 41, 43, 46, 56],
  56: [33, 34, 43, 46, 61],
};
const TIPOS_BOLETA = new Set([39, 41]);
const TIPOS_EXENTOS = new Set([34, 41]);

const FORMA_PAGO: Record<string, number> = { contado: 1, credito: 2, "sin-costo": 3 };
const MEDIO_PAGO_BOLETA: Record<string, number> = { efectivo: 1, electronico: 2, transferencia: 3, cheque: 4, otro: 5 };
const TRASLADO: Record<string, number> = {
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
const DESPACHO: Record<string, number> = { receptor: 1, "emisor-cliente": 2, "emisor-otro": 3 };
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const VIGENCIA_RES_154 = "2026-11-01";
const UMBRAL_BOLETA_IDENTIFICADA = 5_000_000;
const MESES_PLAZO_REBAJA = 6;
const MAX_NMB_ITEM = 80;
const MAX_RAZON_REF = 90;
const MAX_ESPERA_S = 3600;
const MAX_PAGINAS_NOTAS = 10;

function opcion(mapa: Record<string, number>, valor: string | undefined, flag: string): number | undefined {
  if (valor === undefined) return undefined;
  const v = mapa[valor.toLowerCase()];
  if (v === undefined) throw new UsageError(`--${flag}: "${valor}" no existe. Usa ${Object.keys(mapa).join(", ")}`);
  return v;
}

function correo(ctx: Contexto): string | undefined {
  const c = texto(ctx.flags, "correo");
  if (c !== undefined && !CORREO.test(c)) throw new UsageError(`--correo: "${c}" no parece un correo`);
  return c;
}

function lista(ctx: Contexto, nombre: string): string[] {
  return (ctx.flags[nombre] as string[] | undefined) ?? [];
}

function detalle(lineas: Array<Linea & { monto: number }>): Obj[] {
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

function numeros(t: Obj): Obj {
  const r: Obj = {};
  for (const k of ["MntNeto", "MntExe", "IVA", "MntTotal"]) if (t[k] !== undefined && t[k] !== null && t[k] !== "") r[k] = Number(t[k]);
  return r;
}

function totalesDte(totales: Obj, tipo: Tipo, modo: Modo): Obj {
  const t = numeros(totales);
  if (modo === "exento") return { MntExe: t.MntExe ?? t.MntTotal ?? 0, MntTotal: t.MntTotal ?? 0 };
  if (tipo.boleta) return t;
  return { MntNeto: t.MntNeto ?? 0, ...(t.MntExe ? { MntExe: t.MntExe } : {}), TasaIVA: TASA_IVA, IVA: t.IVA ?? 0, MntTotal: t.MntTotal ?? 0 };
}

function restarMeses(fechaIso: string, meses: number): string {
  const [a, m, d] = fechaIso.split("-").map(Number) as [number, number, number];
  const total = a * 12 + (m - 1) - meses;
  const anio = Math.floor(total / 12);
  const mes = (total % 12) + 1;
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${anio}-${String(mes).padStart(2, "0")}-${String(Math.min(d, ultimo)).padStart(2, "0")}`;
}

function totalesOriginales(totales: Obj | undefined, modo: Modo): Obj {
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

interface Referencia {
  tipo: number;
  folio: number;
  codRef: 1 | 2 | 3;
  razon: string;
  original: Obj;
  fecha: string;
}

async function referenciaNota(ctx: Contexto, tipo: Tipo, rutPropio: string): Promise<Referencia> {
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
  if (razon.length > MAX_RAZON_REF) throw new ValidationError(`--razon tiene ${razon.length} caracteres y el máximo es ${MAX_RAZON_REF}`);
  if (codRef === 2 && razon.length > MAX_NMB_ITEM) {
    throw new ValidationError(`Con --corrige-texto la razón va también como línea del detalle, que admite ${MAX_NMB_ITEM} caracteres`);
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

async function leerDocumento(ctx: Contexto, rutPropio: string, tipo: number, folio: number | string): Promise<Obj | null> {
  try {
    return (await ctx.client.get(`/document/${rutPropio}/${tipo}/${folio}/json`)) as Obj | null;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    throw new ApiError(`No se pudo leer el documento ${tipo} folio ${folio}: ${e.message}`, e.status, e.code, e.details);
  }
}

function receptorDeNota(ctx: Contexto, ref: Referencia, email: string | undefined): Obj {
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

async function referenciasLibres(ctx: Contexto, rutPropio: string): Promise<Obj[]> {
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

async function notasPrevias(
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

function validarAntesDeEmitir(ctx: Contexto) {
  const clave = texto(ctx.flags, "idempotency-key");
  if (clave !== undefined && clave.trim() === "") throw new UsageError("--idempotency-key no puede ir vacía");
  const espera = texto(ctx.flags, "esperar");
  if (espera !== undefined && entero(espera, "--esperar") > MAX_ESPERA_S) throw new UsageError(`--esperar es de hasta ${MAX_ESPERA_S} segundos`);
  const intervalo = texto(ctx.flags, "intervalo");
  if (intervalo !== undefined) {
    const n = entero(intervalo, "--intervalo");
    if (n < 1 || n > MAX_ESPERA_S) throw new UsageError(`--intervalo va de 1 a ${MAX_ESPERA_S} segundos`);
  }
  const pdf = texto(ctx.flags, "pdf");
  if (pdf !== undefined && pdf.trim() === "") throw new UsageError("--pdf necesita el nombre del archivo");
  if (pdf) {
    if (existsSync(pdf) && !ctx.flags.sobrescribir) throw new UsageError(`Ya existe ${pdf}. Usa otro nombre o --sobrescribir`);
    const carpeta = dirname(resolve(pdf));
    if (!existsSync(carpeta) || !statSync(carpeta).isDirectory()) throw new UsageError(`No existe la carpeta ${carpeta} para guardar el PDF`);
  }
}

function idempotencia(dte: Obj, dada: string | undefined): string {
  const contenido = JSON.stringify(dte);
  const base = dada?.trim() ? `${dada.trim()}\n${contenido}` : contenido;
  return createHash("sha256").update(base).digest("hex");
}

function tokenDe(detalles: unknown): string | null {
  if (!Array.isArray(detalles)) return null;
  const t = detalles.find((d) => d && typeof d === "object" && (d as Obj).field === "token");
  return t ? String((t as Obj).issue) : null;
}

async function enviar(ctx: Contexto, dte: Obj, extra: { respuesta?: string[]; correo?: string }, resumen: Obj, avisos: string[]) {
  validarAntesDeEmitir(ctx);
  const key = idempotencia(dte, texto(ctx.flags, "idempotency-key"));
  const ambiente = ctx.config.env;
  if (!ctx.flags.confirmar) {
    return {
      enSeco: true,
      ambiente,
      resumen,
      avisos,
      idempotencyKey: key,
      dte,
      aviso: `No se emitió nada. Revisa el resumen y el DTE, y repite el comando con --confirmar para emitirlo ante el SII${ambiente === "dev" ? " (ambiente de pruebas)" : ""}.`,
    };
  }

  const pdf = texto(ctx.flags, "pdf");
  const respuesta = [...(extra.respuesta ?? ["FOLIO"])];
  if (pdf && !respuesta.includes("PDF")) respuesta.push("PDF");
  const body: Obj = { response: respuesta, dte };
  if (extra.correo) body.sendEmail = { to: extra.correo };

  let r: unknown;
  try {
    r = await ctx.client.post("/document", body, { idempotencyKey: key });
  } catch (e) {
    if (e instanceof ApiError && e.code === "TIMEOUT") {
      const fechaDte = dte.Encabezado?.IdDoc?.FchEmis;
      throw new ApiError(
        `${e.message}. Para repetirlo exactamente igual aunque cambie el día, agrega --fecha ${fechaDte}` +
          (texto(ctx.flags, "idempotency-key") ? "" : " y usa el mismo comando"),
        0,
        "TIMEOUT",
        { idempotencyKey: key, fecha: fechaDte },
      );
    }
    if (e instanceof ApiError && e.code === "OF-06") {
      const token = tokenDe(e.details);
      return {
        emitido: false,
        yaEmitido: true,
        ambiente,
        token,
        mensaje: e.message,
        aviso:
          "Este mismo documento ya se había enviado (idempotencia). No se emitió uno nuevo. " +
          (token ? `Consulta el existente con: openfactura documento estado --token ${token}` : "Busca el existente con: openfactura emitidos"),
      };
    }
    throw e;
  }

  if (!r || typeof r !== "object" || Array.isArray(r) || typeof (r as Obj).TOKEN !== "string") {
    throw new ApiError(
      "OpenFactura respondió algo que no es una emisión y no se sabe si el documento se emitió. Repite exactamente el mismo comando: la idempotencia evita emitirlo dos veces",
      0,
      "INVALID_RESPONSE",
      { idempotencyKey: key, fecha: dte.Encabezado?.IdDoc?.FchEmis },
    );
  }
  const res = r as Obj;
  const salida: Obj = {
    emitido: true,
    ambiente,
    tipo: dte.Encabezado?.IdDoc?.TipoDTE,
    folio: res.FOLIO ?? null,
    token: res.TOKEN,
    total: dte.Encabezado?.Totales?.MntTotal,
    avisos,
    siguiente: `Consulta si el SII lo aceptó con: openfactura documento estado --token ${res.TOKEN}`,
  };

  try {
    if (res.WARNING) avisos.push(`OpenFactura avisó: ${typeof res.WARNING === "string" ? res.WARNING : JSON.stringify(res.WARNING)}`);
    if (pdf) {
      const bytes = typeof res.PDF === "string" ? Buffer.from(res.PDF, "base64") : Buffer.alloc(0);
      if (bytes.subarray(0, 4).toString("latin1") === "%PDF") {
        writeFileSync(pdf, bytes);
        salida.pdf = { archivo: pdf, bytes: bytes.length };
      } else {
        avisos.push(`El documento se emitió, pero el PDF no llegó bien. Pídelo con: openfactura documento pdf --token ${res.TOKEN}`);
      }
    }
  } catch (e) {
    avisos.push(`El documento se emitió, pero no se pudo guardar el PDF: ${(e as Error).message}`);
  }

  const espera = texto(ctx.flags, "esperar");
  if (espera !== undefined) {
    try {
      salida.estado = await esperarEstado(ctx, res.TOKEN, entero(espera, "--esperar"));
    } catch (e) {
      avisos.push(
        `El documento se emitió, pero no se pudo consultar su estado: ${(e as Error).message}. Reintenta con: openfactura documento estado --token ${res.TOKEN}`,
      );
    }
  }
  return salida;
}

async function esperarEstado(ctx: Contexto, token: string, segundos: number): Promise<string> {
  const intervalo = texto(ctx.flags, "intervalo") !== undefined ? entero(texto(ctx.flags, "intervalo"), "--intervalo") : 10;
  const limite = Date.now() + segundos * 1000;
  let estado = "Sin estado";
  for (;;) {
    const r = (await ctx.client.get(`/document/${token}/status`)) as Obj | null;
    estado = String(r?.estado ?? estado);
    if (!["Sin estado", "Pendiente"].includes(estado) || Date.now() >= limite) return estado;
    await new Promise((res) => setTimeout(res, intervalo * 1000));
  }
}

async function emitirTipo(ctx: Contexto, nombre: string) {
  const tipo = TIPOS[nombre];
  if (!tipo) throw new UsageError(`Tipo "${nombre}" no existe. Usa: ${[...Object.keys(TIPOS), "archivo"].join(", ")}`);
  validarAntesDeEmitir(ctx);
  const avisos: string[] = [];
  const fechaEmision = fecha(texto(ctx.flags, "fecha") ?? hoy(), "fecha");
  if (fechaEmision > hoy()) avisos.push(`La fecha de emisión ${fechaEmision} es futura`);
  const email = correo(ctx);
  const entrada = lista(ctx, "item").map((t, i) => parsearItem(t, i + 1, avisos));

  if (!tipo.nota && (ctx.flags["sin-rebaja"] || texto(ctx.flags, "referencia"))) {
    throw new UsageError("--referencia y --sin-rebaja son sólo para notas de crédito y débito. Para citar una guía u orden de compra usa --ref");
  }
  if (tipo.nota && lista(ctx, "ref").length) throw new UsageError("En una nota el documento corregido va con --referencia, no con --ref");
  if (tipo.boleta && lista(ctx, "ref").length) {
    throw new UsageError("La boleta no lleva --ref: su esquema de referencias es otro. Si hace falta, arma el DTE y emítelo con: openfactura emitir archivo");
  }

  const org = ((await ctx.client.get("/organization")) ?? {}) as Obj;
  const acteco = texto(ctx.flags, "acteco");
  const emisor = emisorDesdeOrganizacion(org, tipo.boleta, acteco ? entero(acteco, "--acteco") : undefined, avisos);
  const rutPropio = normalizarRut(String(emisor.RUTEmisor));

  const ref = tipo.nota ? await referenciaNota(ctx, tipo, rutPropio) : undefined;
  const modo: Modo = ref ? (TIPOS_EXENTOS.has(ref.tipo) ? "exento" : TIPOS_BOLETA.has(ref.tipo) ? "bruto" : "neto") : tipo.modo;
  if (ctx.flags["con-iva"] && modo !== "neto") {
    throw new UsageError(
      "--con-iva es para factura y notas sobre factura. En boleta y en notas sobre boleta el precio ya va con IVA; en documentos exentos no hay IVA",
    );
  }
  const origTotales = ref ? totalesOriginales(ref.original.Encabezado.Totales, modo) : undefined;

  let receptor: Obj;
  let fichaReceptor: Obj | undefined;
  const rutReceptor = texto(ctx.flags, "receptor");
  if (ref) {
    receptor = receptorDeNota(ctx, ref, email);
  } else if (rutReceptor) {
    const rut = normalizarRut(rutReceptor);
    fichaReceptor = ((await ctx.client.get(`/taxpayer/${rut}`)) ?? {}) as Obj;
    const manual = {
      razonSocial: texto(ctx.flags, "razon-social"),
      giro: texto(ctx.flags, "giro"),
      direccion: texto(ctx.flags, "direccion"),
      comuna: texto(ctx.flags, "comuna"),
      contacto: texto(ctx.flags, "contacto"),
      correo: email,
    };
    receptor = receptorDesdeFicha(rut, fichaReceptor, manual, tipo.boleta, avisos);
  } else if (tipo.receptor === "opcional") {
    receptor = { ...RECEPTOR_CONSUMIDOR_FINAL, ...(email ? { CorreoRecep: email } : {}) };
  } else {
    throw new UsageError("Falta --receptor <rut>");
  }

  let det: Obj[];
  let totales: Obj;
  if (ref?.codRef === 1) {
    if (entrada.length) throw new UsageError("--anula deja sin efecto el documento completo y no lleva --item. Para rebajar una parte usa --corrige-montos");
    const t = ref.original.Encabezado.Totales ?? {};
    if (t.ImptoReten || t.OtrosImp || t.MntNF || ref.original.DscRcgGlobal) {
      throw new ValidationError(
        "El documento original trae impuestos adicionales, montos no facturables o descuentos globales que --anula no copia. Arma la nota completa con: openfactura emitir archivo",
      );
    }
    det = ref.original.Detalle;
    if (!Array.isArray(det) || det.length === 0) throw new ValidationError("El documento original no trae detalle para copiar");
    totales = totalesDte(origTotales!, tipo, modo);
  } else if (ref?.codRef === 2) {
    if (entrada.length) throw new UsageError("--corrige-texto no lleva --item: la corrección va en --razon");
    det = [{ NroLinDet: 1, NmbItem: ref.razon, QtyItem: 1, MontoItem: 0, ...(modo === "exento" ? { IndExe: 1 } : {}) }];
    totales = totalesDte({ MntNeto: 0, MntExe: 0, IVA: 0, MntTotal: 0 }, tipo, modo);
  } else {
    if (!ref && entrada.length && entrada.every((l) => l.exento) && (tipo.codigo === 33 || tipo.codigo === 39)) {
      throw new ValidationError(`Todas las líneas son exentas: corresponde ${tipo.codigo === 33 ? "factura-exenta (34)" : "boleta-exenta (41)"}, no ${nombre}`);
    }
    const calculo = calcularTotales(modo, entrada, { preciosConIva: Boolean(ctx.flags["con-iva"]), permitirCero: tipo.guia });
    avisos.push(...calculo.avisos);
    det = detalle(calculo.lineas);
    totales = totalesDte(calculo.totales, tipo, modo);
  }

  if (ref && tipo.codigo === 61 && ref.codRef !== 2) {
    const nombres: Record<string, string> = { MntNeto: "el neto", MntExe: "el monto exento", IVA: "el IVA", MntTotal: "el total" };
    const previas = await notasPrevias(ctx, ref, rutPropio, receptor, avisos);
    const acumulado = (k: string) => (totales[k] ?? 0) + (previas?.suma[k] ?? 0);
    const excesos = ["MntNeto", "MntExe", "IVA", "MntTotal"]
      .filter((k) => acumulado(k) > (origTotales![k] ?? 0))
      .map((k) => `${nombres[k]} (${acumulado(k)} contra ${origTotales![k] ?? 0})`);
    if (excesos.length) {
      const ya = previas?.folios.length ? ` Ya hay notas de crédito contra este documento: ${previas.folios.join(", ")}.` : "";
      throw new ValidationError(`La nota de crédito supera lo que tiene el documento que corrige en ${excesos.join(", ")}.${ya}`);
    }
  }

  if (ref) {
    if (fechaEmision < ref.fecha) throw new ValidationError(`La nota no puede tener fecha (${fechaEmision}) anterior al documento que corrige (${ref.fecha})`);
    if (tipo.codigo === 61 && ref.codRef !== 2 && ref.fecha < restarMeses(fechaEmision, MESES_PLAZO_REBAJA) && !ctx.flags["sin-rebaja"]) {
      avisos.push(
        `El documento es de hace más de ${MESES_PLAZO_REBAJA} meses. Si la nota es por una devolución o resciliación, ya no da derecho a rebajar el IVA (DL 825 art. 21 N° 2): emítela con --sin-rebaja. Un descuento posterior no tiene ese plazo`,
      );
    }
  }

  const idDoc: Obj = { TipoDTE: tipo.codigo, Folio: 0, FchEmis: fechaEmision };
  if (modo === "bruto" && tipo.nota) idDoc.MntBruto = 1;
  if (ctx.flags["sin-rebaja"]) {
    if (tipo.codigo !== 61) throw new UsageError("--sin-rebaja es sólo para notas de crédito");
    idDoc.IndNoRebaja = 1;
  }
  if (tipo.boleta) {
    const ind = texto(ctx.flags, "ind-servicio");
    idDoc.IndServicio = ind ? entero(ind, "--ind-servicio") : 3;
    if ((idDoc.IndServicio === 1 || idDoc.IndServicio === 2) && !rutReceptor) {
      throw new ValidationError("Una boleta de servicio periódico es nominativa: indica el cliente con --receptor (Res. Ex. SII 74/2020)");
    }
    const medio = opcion(MEDIO_PAGO_BOLETA, texto(ctx.flags, "medio-pago"), "medio-pago");
    if (medio !== undefined) idDoc.MedioPago = medio;
    if (totales.MntTotal > UMBRAL_BOLETA_IDENTIFICADA && (!rutReceptor || medio === undefined)) {
      throw new ValidationError(
        "Una boleta sobre 135 UF exige nombre y RUT del comprador y la forma de pago (Res. Ex. SII 44/2025). " +
          `Sobre ${UMBRAL_BOLETA_IDENTIFICADA.toLocaleString("es-CL")} pesos el CLI los pide siempre: agrega --receptor y --medio-pago`,
      );
    }
    if (fichaReceptor && Array.isArray(fichaReceptor.actividades) && fichaReceptor.actividades.some((a: Obj) => a?.giro)) {
      avisos.push("El receptor tiene giro en el SII. Si compra para su negocio, corresponde factura y no boleta (DL 825 art. 53 letra a)");
    }
  } else {
    const forma = opcion(FORMA_PAGO, texto(ctx.flags, "forma-pago"), "forma-pago");
    if (forma !== undefined) idDoc.FmaPago = forma;
  }

  const encabezado: Obj = { IdDoc: idDoc, Emisor: emisor, Receptor: receptor };
  if (tipo.guia) {
    const traslado = opcion(TRASLADO, texto(ctx.flags, "traslado"), "traslado");
    if (traslado === undefined) throw new UsageError(`La guía necesita --traslado: ${Object.keys(TRASLADO).join(", ")}`);
    const despacho = opcion(DESPACHO, texto(ctx.flags, "despacho"), "despacho");
    idDoc.IndTraslado = traslado;
    if (despacho !== undefined) idDoc.TipoDespacho = despacho;
    const transporte: Obj = {};
    const limpio = (n: string) => texto(ctx.flags, n)?.trim() || undefined;
    const placa = (n: string) =>
      limpio(n)
        ?.toUpperCase()
        .replace(/[\s.-]/g, "") || undefined;
    const patente = placa("patente");
    const carro = placa("patente-carro");
    const trans = limpio("transportista-rut");
    const choferRut = limpio("chofer-rut");
    const choferNombre = limpio("chofer-nombre");
    const dir = limpio("destino-direccion");
    const cmna = limpio("destino-comuna");
    if (patente) transporte.Patente = patente;
    if (carro) transporte.PatenteCarro = carro;
    if (trans) transporte.RUTTrans = normalizarRut(trans);
    if (choferRut || choferNombre) {
      transporte.Chofer = { ...(choferRut ? { RUTChofer: normalizarRut(choferRut) } : {}), ...(choferNombre ? { NombreChofer: choferNombre } : {}) };
    }
    if (dir) transporte.DirDest = dir;
    if (cmna) transporte.CmnaDest = cmna;
    const faltan = [
      !dir && "--destino-direccion",
      !cmna && "--destino-comuna",
      !choferRut && "--chofer-rut",
      !choferNombre && "--chofer-nombre",
      !patente && "--patente",
      !trans && "--transportista-rut",
    ].filter(Boolean);
    if (faltan.length) {
      const mensaje = `La Res. Ex. SII 154/2025 exige en las guías origen, destino, chofer, transportista y patente desde el ${VIGENCIA_RES_154}. Falta: ${faltan.join(", ")}`;
      if (fechaEmision >= VIGENCIA_RES_154) throw new ValidationError(mensaje);
      avisos.push(mensaje);
    }
    if (Object.keys(transporte).length) encabezado.Transporte = transporte;
    if (traslado === 1 && totales.MntTotal === 0) avisos.push("Es una guía de venta con monto cero: revisa los precios, o usa otro --traslado si no es venta");
  }
  encabezado.Totales = totales;

  let dte: Obj = { Encabezado: encabezado, Detalle: det };
  if (ref) {
    dte.Referencia = [{ NroLinRef: 1, TpoDocRef: String(ref.tipo), FolioRef: ref.folio, FchRef: ref.fecha, CodRef: ref.codRef, RazonRef: ref.razon }];
  } else {
    const refs = await referenciasLibres(ctx, rutPropio);
    if (refs.length) dte.Referencia = refs;
  }
  dte = ordenarDte(dte, tipo.boleta);
  validarContraEsquema(dte, tipo.boleta);

  const resumen = {
    tipo: tipo.codigo,
    nombre,
    fecha: fechaEmision,
    receptor: receptor.RznSocRecep,
    rutReceptor: receptor.RUTRecep,
    neto: totales.MntNeto,
    exento: totales.MntExe,
    iva: totales.IVA,
    total: totales.MntTotal,
    lineas: det.length,
    ...(ref ? { referencia: `${ref.tipo}:${ref.folio}`, codRef: ref.codRef } : {}),
  };
  return enviar(ctx, dte, { correo: email }, resumen, avisos);
}

async function emitirArchivo(ctx: Contexto) {
  const ruta = arg(ctx, 1, "archivo.json");
  let contenido: Obj;
  try {
    contenido = JSON.parse(readFileSync(ruta, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    throw new UsageError(`No se pudo leer ${ruta} como JSON: ${(e as Error).message}`);
  }
  if (!contenido || typeof contenido !== "object" || Array.isArray(contenido)) throw new ValidationError("El archivo debe tener un objeto JSON con el DTE");
  const esBody = "dte" in contenido;
  const dte: Obj = esBody ? contenido.dte : contenido;
  const idDoc = dte?.Encabezado?.IdDoc;
  if (!idDoc || !Number.isInteger(Number(idDoc.TipoDTE))) throw new ValidationError("El DTE no trae Encabezado.IdDoc.TipoDTE");
  if (idDoc.Folio !== undefined && Number(idDoc.Folio) !== 0) {
    throw new ValidationError("IdDoc.Folio debe ser 0: el folio lo asigna OpenFactura al emitir");
  }
  const email = correo(ctx);
  const correoArchivo = esBody ? contenido.sendEmail?.to : undefined;
  if (
    correoArchivo !== undefined &&
    !String(correoArchivo)
      .split(",")
      .every((c) => CORREO.test(c.trim()))
  ) {
    throw new ValidationError(`sendEmail.to del archivo no es un correo válido: "${correoArchivo}"`);
  }
  const respuesta = esBody && Array.isArray(contenido.response) ? contenido.response : undefined;
  const resumen = { tipo: Number(idDoc.TipoDTE), archivo: ruta, receptor: dte.Encabezado?.Receptor?.RznSocRecep, total: dte.Encabezado?.Totales?.MntTotal };
  return enviar(ctx, dte, { respuesta, correo: email ?? correoArchivo }, resumen, []);
}

const USO = `openfactura emitir <tipo> [opciones]
openfactura emitir archivo <dte.json> [--confirmar]

Tipos: factura (33), factura-exenta (34), boleta (39), boleta-exenta (41),
       nota-credito (61), nota-debito (56), guia (52).
Cualquier otro tipo (43 liquidación-factura, 46 factura de compra, exportación) va con "archivo".

EN SECO POR DEFECTO. Sin --confirmar arma el DTE, calcula los totales y lo muestra sin emitir.
Emitir es irreversible: un error se corrige con nota de crédito, no borrando.

Ítems (repetible):
  --item "nombre|cantidad|precio"          Precio unitario, sin separador de miles (69000, no 69.000).
                                           Neto en factura y notas; con IVA en boleta y en notas sobre boleta
  --item "nombre|cantidad|precio|exento"   Línea exenta de IVA. Sólo si la ley la declara exenta
  --item '{"nombre":"..","cantidad":1,"precio":1000,"exento":false,"descripcion":".."}'
  --con-iva        En factura, los precios vienen con IVA y se desglosan

Receptor:
  --receptor <rut>   Se completa con la ficha del SII. Obligatorio salvo en boletas y notas
  --razon-social, --giro, --direccion, --comuna, --contacto   Reemplazan lo que traiga el SII
  --correo <email>   Correo del receptor. OpenFactura le manda el documento cuando el SII lo acepta

Documento:
  --fecha AAAA-MM-DD          Fecha de emisión (default: hoy en Chile)
  --forma-pago contado|credito|sin-costo          (factura, notas, guía)
  --medio-pago efectivo|electronico|transferencia|cheque|otro   (boleta)
  --ind-servicio <n>          Boleta: 3 venta y servicios (default); 1 y 2 servicios periódicos (nominativa)
  --acteco <código>           Actividad económica del emisor, si no es la principal
  --ref <tipo>:<folio>[:fecha]  Documento que se cita (repetible): 52 guía, 801 orden de compra, etc.
                              Para una guía propia la fecha se busca sola

Notas de crédito y débito:
  --referencia <tipo>:<folio>   Documento que se corrige, ej. 33:30. Receptor y fecha salen de ahí
  --anula                       Anula el documento completo, copiando su detalle. No lleva --item
  --corrige-montos              Rebaja (crédito) o aumenta (débito) por los --item que indiques
  --corrige-texto               Corrige un dato sin tocar montos. Va con --razon
  --razon "<texto>"             Motivo que queda en la referencia
  --sin-rebaja                  Nota de crédito que no rebaja el IVA (devolución fuera de plazo)
  El receptor es siempre el del original. Un RUT equivocado se corrige anulando y reemitiendo.

Guía de despacho:
  --traslado venta|venta-por-efectuar|consignacion|entrega-gratuita|interno|otro-traslado|
             devolucion|traslado-exportacion|venta-exportacion
  --despacho receptor|emisor-cliente|emisor-otro
  --destino-direccion, --destino-comuna
  --chofer-rut, --chofer-nombre, --transportista-rut, --patente, --patente-carro
  Desde el ${VIGENCIA_RES_154} la Res. Ex. SII 154/2025 hace obligatorios destino, chofer, transportista y patente.

Envío:
  --confirmar             Emite de verdad ante el SII
  --pdf <archivo>         Guarda el PDF que devuelve la emisión
  --esperar <segundos>    Espera a que el SII responda Aceptado o Rechazado
  --intervalo <segundos>  Cada cuánto consulta mientras espera (default 10, mínimo 1)
  --idempotency-key <k>   Por defecto es el sha256 del DTE: repetir el mismo comando no emite dos veces.
                          Para dos ventas idénticas el mismo día (dos boletas iguales), pasa una clave distinta`;

export const EMISION: Comando[] = [
  {
    nombre: "emitir",
    minArgs: 1,
    maxArgs: 2,
    resumen: "Emite factura, boleta, notas, guía o un DTE desde archivo (en seco sin --confirmar)",
    uso: USO,
    flags: {
      item: { type: "string", multiple: true },
      "con-iva": { type: "boolean" },
      receptor: { type: "string" },
      "razon-social": { type: "string" },
      giro: { type: "string" },
      direccion: { type: "string" },
      comuna: { type: "string" },
      contacto: { type: "string" },
      correo: { type: "string" },
      fecha: { type: "string" },
      "forma-pago": { type: "string" },
      "medio-pago": { type: "string" },
      "ind-servicio": { type: "string" },
      acteco: { type: "string" },
      ref: { type: "string", multiple: true },
      referencia: { type: "string" },
      anula: { type: "boolean" },
      "corrige-montos": { type: "boolean" },
      "corrige-texto": { type: "boolean" },
      razon: { type: "string" },
      "sin-rebaja": { type: "boolean" },
      traslado: { type: "string" },
      despacho: { type: "string" },
      "destino-direccion": { type: "string" },
      "destino-comuna": { type: "string" },
      "chofer-rut": { type: "string" },
      "chofer-nombre": { type: "string" },
      "transportista-rut": { type: "string" },
      patente: { type: "string" },
      "patente-carro": { type: "string" },
      confirmar: { type: "boolean" },
      pdf: { type: "string" },
      sobrescribir: { type: "boolean" },
      esperar: { type: "string" },
      intervalo: { type: "string" },
      "idempotency-key": { type: "string" },
    },
    run: (ctx) => {
      const tipo = arg(ctx, 0, "tipo");
      if (tipo !== "archivo" && ctx.args.length > 1) throw new UsageError(`Sobran argumentos: ${ctx.args.slice(1).join(" ")}`);
      return tipo === "archivo" ? emitirArchivo(ctx) : emitirTipo(ctx, tipo);
    },
  },
];
