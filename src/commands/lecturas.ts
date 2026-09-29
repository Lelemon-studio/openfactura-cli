import { existsSync, writeFileSync } from "node:fs";
import { ApiError } from "../client.ts";
import { type Comando, type Contexto, type Flags, UsageError, arg, entero, requerido, texto } from "../command.ts";
import { fecha, periodo, rutaPeriodo } from "../fechas.ts";
import { normalizarRut, rutCuerpo } from "../rut.ts";

const MAX_PAGINAS = 500;

export async function rutEmisor(ctx: Contexto): Promise<string> {
  const dado = texto(ctx.flags, "rut");
  if (dado) return normalizarRut(dado);
  const org = (await ctx.client.get("/organization")) as { rut?: string } | null;
  if (!org?.rut) throw new ApiError("OpenFactura no devolvió el RUT del emisor", 0, "NO_ISSUER");
  return normalizarRut(org.rut);
}

export function enSeco(ctx: Contexto, accion: string, endpoint: string, body: unknown, ejecutar: () => Promise<unknown>) {
  if (ctx.flags.confirmar) return ejecutar();
  return {
    enSeco: true,
    accion,
    endpoint,
    body,
    aviso: "No se envió nada. Revisa los datos y repite el comando con --confirmar para ejecutarlo.",
  };
}

const CONFIRMAR = { confirmar: { type: "boolean" } } as const;

function rango(flags: Flags, desde: string, hasta: string, exacta?: string): Record<string, string> | undefined {
  const r: Record<string, string> = {};
  const d = texto(flags, desde);
  const h = texto(flags, hasta);
  const e = exacta ? texto(flags, exacta) : undefined;
  if (e) r.eq = fecha(e, exacta!);
  if (d) r.gte = fecha(d, desde);
  if (h) r.lte = fecha(h, hasta);
  return Object.keys(r).length ? r : undefined;
}

interface Pagina {
  current_page?: number;
  last_page?: number;
  total?: number | string;
  data?: Array<Record<string, unknown>>;
}

async function listar(ctx: Contexto, ruta: string, filtros: Record<string, unknown>) {
  const folio = texto(ctx.flags, "folio");
  const todas = Boolean(ctx.flags.todas) || folio !== undefined;
  let pagina = texto(ctx.flags, "pagina") ? entero(texto(ctx.flags, "pagina"), "--pagina") : 1;
  if (pagina < 1) throw new UsageError("--pagina parte en 1");
  if (folio !== undefined && texto(ctx.flags, "pagina")) throw new UsageError("--folio recorre todas las páginas: no se combina con --pagina");
  const documentos: Array<Record<string, unknown>> = [];
  const avisos: string[] = [];
  const primera = pagina;
  let ultima = 0;
  let total = 0;
  let errorPagina: { code: string; status: number } | undefined;

  for (;;) {
    const body = pagina > 1 ? { ...filtros, Page: pagina } : filtros;
    let r: Pagina | null;
    try {
      r = (await ctx.client.post(ruta, body)) as Pagina | null;
    } catch (e) {
      if (pagina === primera) throw e;
      if (e instanceof ApiError) errorPagina = { code: e.code, status: e.status };
      avisos.push(`El listado quedó incompleto: falló la página ${pagina} de ${ultima} (${(e as Error).message}). Lo de arriba es lo que alcanzó a bajar.`);
      break;
    }
    if (!r) {
      if (pagina > primera && pagina <= ultima)
        avisos.push(`El listado quedó incompleto: la página ${pagina} de ${ultima} llegó vacía. Lo de arriba es lo que alcanzó a bajar.`);
      break;
    }
    documentos.push(...(r.data ?? []));
    const ultimaInformada = Number(r.last_page);
    if (r.last_page !== undefined && Number.isInteger(ultimaInformada) && ultimaInformada >= 0) ultima = ultimaInformada;
    else ultima = Math.max(ultima, pagina);
    const totalInformado = Number(r.total);
    if (r.total !== undefined && Number.isFinite(totalInformado)) total = totalInformado;
    else total = Math.max(total, documentos.length);
    if (!todas || pagina >= ultima) break;
    if (pagina - primera + 1 >= MAX_PAGINAS) {
      avisos.push(
        `El listado quedó incompleto: se bajaron ${MAX_PAGINAS} páginas y quedan hasta la ${ultima}. Acota con --desde y --hasta, o sigue con --pagina ${pagina + 1}.`,
      );
      break;
    }
    pagina++;
  }

  const extra = avisos.length ? { incompleto: true, avisos, ...(errorPagina ? { errorPagina } : {}) } : {};
  if (folio !== undefined) {
    const buscado = entero(folio, "--folio");
    const filtrados = documentos.filter((d) => Number(d.Folio) === buscado);
    if (avisos.length && !filtrados.length) avisos.push(`El folio ${buscado} no apareció, pero no se revisaron todas las páginas: puede existir igual.`);
    return { total: filtrados.length, paginas: ultima, pagina: 1, documentos: filtrados, ...extra };
  }
  return { total, paginas: ultima, pagina: todas ? 1 : pagina, documentos, ...extra };
}

const FLAGS_LISTA = {
  desde: { type: "string" },
  hasta: { type: "string" },
  fecha: { type: "string" },
  tipo: { type: "string" },
  folio: { type: "string" },
  pagina: { type: "string" },
  todas: { type: "boolean" },
} as const;

function filtroTipo(flags: Flags): Record<string, unknown> {
  const t = texto(flags, "tipo");
  return t === undefined ? {} : { TipoDTE: { eq: entero(t, "--tipo") } };
}

const ACCIONES_DOCUMENTO = ["estado", "json", "xml", "pdf", "cedible"] as const;
const VALOR_API: Record<(typeof ACCIONES_DOCUMENTO)[number], string> = {
  estado: "status",
  json: "json",
  xml: "xml",
  pdf: "pdf",
  cedible: "cedible",
};

function guardarArchivo(ruta: string, bytes: Buffer, forzar: boolean) {
  if (existsSync(ruta) && !forzar) throw new UsageError(`Ya existe ${ruta}. Usa --salida con otro nombre o --sobrescribir`);
  writeFileSync(ruta, bytes);
  return { archivo: ruta, bytes: bytes.length };
}

async function documento(ctx: Contexto) {
  const accion = arg(ctx, 0, "acción") as (typeof ACCIONES_DOCUMENTO)[number];
  if (!ACCIONES_DOCUMENTO.includes(accion)) throw new UsageError(`Acción "${accion}" no existe. Usa: ${ACCIONES_DOCUMENTO.join(", ")}`);
  const valor = VALOR_API[accion];
  const token = texto(ctx.flags, "token");

  let ruta: string;
  let nombreBase: string;
  if (token) {
    if (ctx.args.length > 1) throw new UsageError("Con --token no van tipo ni folio");
    if (!/^[A-Za-z0-9]+$/.test(token)) throw new UsageError("--token sólo admite letras y números");
    ruta = `/document/${token}/${valor}`;
    nombreBase = token.slice(0, 16);
  } else {
    const tipo = entero(arg(ctx, 1, "tipo"), "<tipo>");
    const folio = entero(arg(ctx, 2, "folio"), "<folio>");
    const rut = await rutEmisor(ctx);
    ruta = `/document/${rut}/${tipo}/${folio}/${valor}`;
    nombreBase = `${rut}_${tipo}_${folio}`;
  }

  const r = (await ctx.client.get(ruta)) as Record<string, unknown> | null;
  if (accion === "estado" || accion === "json") return r;

  const campo = accion === "xml" ? "xml" : "pdf";
  const b64 = r?.[campo];
  if (typeof b64 !== "string" || b64 === "") throw new ApiError(`OpenFactura no devolvió el campo ${campo}`, 0, "NO_FILE");
  if (!/^[A-Za-z0-9+/\s]+={0,2}\s*$/.test(b64)) throw new ApiError(`OpenFactura devolvió un ${campo} que no es base64`, 0, "INVALID_FILE");
  const bytes = Buffer.from(b64, "base64");
  if (campo === "pdf" && bytes.subarray(0, 4).toString("latin1") !== "%PDF") {
    throw new ApiError("Lo que devolvió OpenFactura no es un PDF", 0, "INVALID_PDF");
  }
  const sufijo = accion === "cedible" ? "_cedible.pdf" : accion === "xml" ? ".xml" : ".pdf";
  return guardarArchivo(texto(ctx.flags, "salida") ?? `${nombreBase}${sufijo}`, bytes, Boolean(ctx.flags.sobrescribir));
}

const ESTADOS_COMPRA: Record<string, string> = {
  pendiente: "pending",
  registrado: "registered",
  excluido: "exclude",
  reclamado: "reclaimed",
};

const ACUSES = ["ACD", "RCD", "ERM", "RFP", "RFT"];

export const LECTURAS: Comando[] = [
  {
    nombre: "emisor",
    maxArgs: 0,
    resumen: "Datos de la empresa emisora dueña de la API key",
    uso: "openfactura emisor [--logo]\n\n  --logo  Incluye el logo de la empresa en base64",
    flags: { logo: { type: "boolean" } },
    run: ({ client, flags }) => client.get(flags.logo ? "/organization?extra_fields=logo" : "/organization"),
  },
  {
    nombre: "folios",
    maxArgs: 0,
    resumen: "Tipos de documento autorizados (el contador de folios no es confiable)",
    uso: [
      "openfactura folios",
      "",
      "Ojo: OpenFactura repone los folios sola y este contador se ha visto quieto después de emitir.",
      "Sirve para saber qué tipos de documento están autorizados, no como semáforo de folios.",
    ].join("\n"),
    run: ({ client }) => client.get("/organization/document"),
  },
  {
    nombre: "contribuyente",
    minArgs: 1,
    maxArgs: 1,
    resumen: "Ficha del SII de cualquier RUT: razón social, giro, dirección y sucursales",
    uso: [
      "openfactura contribuyente <rut>",
      "",
      "Agrega dos campos calculados, porque la API responde 200 aunque el RUT no exista:",
      "  encontrado  false si el SII no devolvió razón social ni dirección",
      "  tieneGiro   false si no tiene actividad económica: a ese RUT se le emite boleta, no factura",
    ].join("\n"),
    run: async (ctx) => {
      const rut = normalizarRut(arg(ctx, 0, "rut"));
      const crudo = await ctx.client.get(`/taxpayer/${rut}`);
      if (crudo !== null && (typeof crudo !== "object" || Array.isArray(crudo))) {
        throw new ApiError("OpenFactura devolvió algo que no es la ficha del contribuyente", 0, "INVALID_RESPONSE");
      }
      const r = (crudo ?? {}) as Record<string, unknown>;
      const actividades = Array.isArray(r.actividades) ? (r.actividades as Array<Record<string, unknown>>) : [];
      const encontrado = Boolean(r.razonSocial || r.direccion);
      const tieneGiro = actividades.some((a) => a.giro || a.codigoActividadEconomica || a.actividadEconomica);
      return { encontrado, tieneGiro, ...r };
    },
  },
  {
    nombre: "documento",
    minArgs: 1,
    maxArgs: 3,
    resumen: "Estado ante el SII, JSON, XML, PDF o copia cedible de un documento",
    uso: [
      "openfactura documento <estado|json|xml|pdf|cedible> <tipo> <folio> [--rut <rut-emisor>]",
      "openfactura documento <estado|json|xml|pdf|cedible> --token <token>",
      "",
      "  --rut          RUT del emisor. Por defecto, el de la API key. Para un documento RECIBIDO,",
      "                 pon el RUT de quien lo emitió",
      "  --token        Token que devolvió la emisión (sólo emitidos)",
      "  --salida       Archivo donde guardar el PDF o XML. Por defecto <rut>_<tipo>_<folio>.pdf",
      "  --sobrescribir Reemplaza el archivo si ya existe",
      "",
      "Estados posibles: Aceptado, Aceptado con Reparo, Rechazado, Pendiente y Sin estado. Recién",
      "emitido es normal ver Sin estado unos minutos; si dura horas, algo anda mal.",
    ].join("\n"),
    flags: {
      rut: { type: "string" },
      token: { type: "string" },
      salida: { type: "string" },
      sobrescribir: { type: "boolean" },
    },
    run: documento,
  },
  {
    nombre: "emitidos",
    maxArgs: 0,
    resumen: "Lista los documentos emitidos, con filtros",
    uso: [
      "openfactura emitidos [--desde AAAA-MM-DD] [--hasta AAAA-MM-DD] [--fecha AAAA-MM-DD]",
      "                     [--tipo <n>] [--rut-receptor <rut>] [--folio <n>] [--pagina <n> | --todas]",
      "",
      "  Las fechas filtran por fecha de emisión. La API entrega 30 por página.",
      "  --folio  Se filtra acá y no en la API, porque la API ignora ese filtro sin avisar.",
      "           Recorre todas las páginas, así que conviene acotar con --tipo y fechas.",
    ].join("\n"),
    flags: { ...FLAGS_LISTA, "rut-receptor": { type: "string" } },
    run: (ctx) => {
      const filtros: Record<string, unknown> = { ...filtroTipo(ctx.flags) };
      const f = rango(ctx.flags, "desde", "hasta", "fecha");
      if (f) filtros.FchEmis = f;
      const rut = texto(ctx.flags, "rut-receptor");
      if (rut) filtros.RUTRecep = { eq: rutCuerpo(rut) };
      return listar(ctx, "/document/issued", filtros);
    },
  },
  {
    nombre: "recibidos",
    maxArgs: 0,
    resumen: "Lista los documentos recibidos de proveedores, con filtros",
    uso: [
      "openfactura recibidos [--desde] [--hasta] [--fecha] [--tipo <n>] [--rut-emisor <rut>]",
      "                      [--recepcion-desde] [--recepcion-hasta] [--folio <n>] [--pagina <n> | --todas]",
      "",
      "  --desde/--hasta/--fecha      Fecha de emisión del documento",
      "  --recepcion-desde/-hasta     Fecha en que llegó a OpenFactura. Sirve para pillar documentos",
      "                               que llegan con fecha de emisión atrasada",
    ].join("\n"),
    flags: {
      ...FLAGS_LISTA,
      "rut-emisor": { type: "string" },
      "recepcion-desde": { type: "string" },
      "recepcion-hasta": { type: "string" },
    },
    run: (ctx) => {
      const filtros: Record<string, unknown> = { ...filtroTipo(ctx.flags) };
      const f = rango(ctx.flags, "desde", "hasta", "fecha");
      if (f) filtros.FchEmis = f;
      const r = rango(ctx.flags, "recepcion-desde", "recepcion-hasta");
      if (r) filtros.FchRecepOF = r;
      const rut = texto(ctx.flags, "rut-emisor");
      if (rut) filtros.RUTEmisor = { eq: rutCuerpo(rut) };
      return listar(ctx, "/document/received", filtros);
    },
  },
  {
    nombre: "acusar",
    minArgs: 2,
    maxArgs: 2,
    resumen: "Acepta o reclama un documento recibido ante el SII (pide --confirmar)",
    uso: [
      "openfactura acusar <tipo> <folio> --rut-emisor <rut> --acuse <ACD|RCD|ERM|RFP|RFT> [--confirmar]",
      "",
      "  ACD  Acepta el contenido      RCD  Reclama el contenido",
      "  ERM  Recibo de mercaderías    RFP  Reclamo por falta parcial    RFT  Reclamo por falta total",
      "",
      "Queda registrado en el SII y no se deshace. Sin --confirmar sólo muestra lo que enviaría.",
    ].join("\n"),
    flags: { "rut-emisor": { type: "string" }, acuse: { type: "string" }, ...CONFIRMAR },
    run: (ctx) => {
      const acuse = requerido(ctx.flags, "acuse").toUpperCase();
      if (!ACUSES.includes(acuse)) throw new UsageError(`--acuse debe ser uno de ${ACUSES.join(", ")}`);
      const body = {
        dte: entero(arg(ctx, 0, "tipo"), "<tipo>"),
        folio: entero(arg(ctx, 1, "folio"), "<folio>"),
        rut: normalizarRut(requerido(ctx.flags, "rut-emisor")),
        acuse,
      };
      return enSeco(ctx, "acusar documento recibido", "POST /document/received/accuse", body, () => ctx.client.post("/document/received/accuse", body));
    },
  },
  {
    nombre: "ventas",
    minArgs: 1,
    maxArgs: 1,
    resumen: "Resumen del registro de ventas de un mes o un día, por tipo de documento",
    uso: "openfactura ventas <AAAA-MM | AAAA-MM-DD>",
    run: (ctx) => ctx.client.get(`/registry/sales/${rutaPeriodo(periodo(arg(ctx, 0, "período")))}`),
  },
  {
    nombre: "compras",
    minArgs: 1,
    maxArgs: 1,
    resumen: "Resumen del registro de compras de un mes o un día, separado por estado",
    uso: ["openfactura compras <AAAA-MM | AAAA-MM-DD> [--estado pendiente,registrado,excluido,reclamado]"].join("\n"),
    flags: { estado: { type: "string" } },
    run: (ctx) => {
      let ruta = `/registry/purchase/${rutaPeriodo(periodo(arg(ctx, 0, "período")))}`;
      const estado = texto(ctx.flags, "estado");
      if (estado) {
        const valores = estado.split(",").map((e) => {
          const v = ESTADOS_COMPRA[e.trim().toLowerCase()];
          if (!v) throw new UsageError(`--estado: "${e}" no existe. Usa ${Object.keys(ESTADOS_COMPRA).join(", ")}`);
          return v;
        });
        ruta += `?status=${encodeURIComponent(valores.join(","))}`;
      }
      return ctx.client.get(ruta);
    },
  },
  {
    nombre: "sincronizar-rcv",
    minArgs: 2,
    maxArgs: 2,
    resumen: "Pide a OpenFactura traer del SII el registro de compras o ventas de un mes",
    uso: [
      "openfactura sincronizar-rcv <ventas|compras> <AAAA-MM>",
      "",
      "Queda en cola y no devuelve datos. Tiene su propio límite: si responde OF-429, espera los",
      "segundos de retry_after antes de volver a pedirlo.",
    ].join("\n"),
    run: (ctx) => {
      const registro = { ventas: "sales", compras: "purchase" }[arg(ctx, 0, "ventas|compras")];
      if (!registro) throw new UsageError("El registro debe ser ventas o compras");
      const p = periodo(arg(ctx, 1, "período"));
      if (p.dia) throw new UsageError("El período va sin día: AAAA-MM");
      return ctx.client.post("/registry/sync-rcv", { registro, periodo: Number(`${p.anio}${p.mes}`) });
    },
  },
  {
    nombre: "anular-guia",
    minArgs: 1,
    maxArgs: 1,
    resumen: "Anula una guía de despacho (52) ante el SII (pide --confirmar)",
    uso: [
      "openfactura anular-guia <folio> --fecha <AAAA-MM-DD> [--confirmar]",
      "",
      "  --fecha  Fecha de emisión de la guía",
      "",
      "Es el único tipo de documento que la API permite anular. Una factura o boleta se corrige con",
      "una nota de crédito. Sin --confirmar sólo muestra lo que enviaría.",
    ].join("\n"),
    flags: { fecha: { type: "string" }, ...CONFIRMAR },
    run: (ctx) => {
      const body = { Dte: 52, Folio: entero(arg(ctx, 0, "folio"), "<folio>"), Fecha: fecha(requerido(ctx.flags, "fecha"), "fecha") };
      return enSeco(ctx, "anular guía de despacho", "POST /anularDTE52", body, () => ctx.client.post("/anularDTE52", body));
    },
  },
];
