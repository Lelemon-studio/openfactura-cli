#!/usr/bin/env node

// src/cli.ts
import { parseArgs } from "node:util";

// src/client.ts
class ApiError extends Error {
  status;
  code;
  details;
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.name = "ApiError";
  }
  toJSON() {
    return { error: this.message, status: this.status, code: this.code, details: this.details };
  }
}
var MAX_REINTENTOS_429 = 3;
var MAX_ESPERA_429_S = 60;
var utf8Estricto = new TextDecoder("utf-8", { fatal: true });
var latin1 = new TextDecoder("latin1");
function decodificar(bytes) {
  try {
    return utf8Estricto.decode(bytes);
  } catch {
    return latin1.decode(bytes);
  }
}
function parsear(texto) {
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

class OpenFacturaClient {
  opts;
  constructor(opts) {
    this.opts = opts;
  }
  get(path) {
    return this.request("GET", path);
  }
  post(path, body, options = {}) {
    return this.request("POST", path, body, options);
  }
  async request(method, path, body, options = {}) {
    const esperar = this.opts.esperar ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    for (let intento = 0;; intento++) {
      try {
        return await this.unaVez(method, path, body, options);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 429 || e.code === "OF-429")
          throw e;
        if (intento >= MAX_REINTENTOS_429) {
          throw new ApiError(`OpenFactura sigue limitando las llamadas después de ${MAX_REINTENTOS_429} reintentos: ${e.message}`, 429, "RATE_LIMIT");
        }
        const segundos = Math.max(1, Number(/(\d+)\s*second/i.exec(e.message)?.[1] ?? 1));
        if (segundos > MAX_ESPERA_429_S) {
          throw new ApiError(`OpenFactura pide esperar ${segundos} segundos antes de volver a llamar`, 429, "RATE_LIMIT");
        }
        await esperar(segundos * 1000);
      }
    }
  }
  async unaVez(method, path, body, options = {}) {
    const headers = { apikey: this.opts.apiKey, Accept: "application/json" };
    if (body !== undefined)
      headers["Content-Type"] = "application/json";
    if (options.idempotencyKey)
      headers["Idempotency-Key"] = options.idempotencyKey;
    const control = new AbortController;
    let vencido = false;
    const reloj = setTimeout(() => {
      vencido = true;
      control.abort();
    }, this.opts.timeoutMs);
    let res;
    let bytes;
    try {
      res = await fetch(this.opts.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: control.signal
      });
      bytes = await res.arrayBuffer();
    } catch (e) {
      if (vencido) {
        const extra = method === "POST" ? ". La operación pudo haberse procesado igual: repite exactamente el mismo comando, que la idempotencia evita duplicarla" : "";
        throw new ApiError(`OpenFactura no respondió en ${this.opts.timeoutMs} ms${extra}`, 0, "TIMEOUT");
      }
      throw new ApiError(`No se pudo conectar con OpenFactura: ${this.ocultar(String(e))}`, 0, "NETWORK");
    } finally {
      clearTimeout(reloj);
    }
    const texto = decodificar(bytes);
    const data = texto.trim() === "" ? null : parsear(texto);
    if (res.ok)
      return data;
    throw this.error(res.status, data);
  }
  error(status, data) {
    const d = data && typeof data === "object" ? data : {};
    const interno = d.error && typeof d.error === "object" ? d.error : d;
    const mensaje = typeof interno.message === "string" ? interno.message : typeof d.error === "string" ? d.error : typeof data === "string" ? data.slice(0, 500) : `HTTP ${status}`;
    const codigo = typeof interno.code === "string" ? interno.code : status === 401 || status === 403 ? "AUTH" : `HTTP_${status}`;
    const reconocido = typeof interno.message === "string" || typeof d.error === "string";
    const detalles = interno.details ?? (reconocido || typeof data === "string" ? undefined : data);
    return new ApiError(this.ocultar(mensaje), status, codigo, this.ocultarEn(detalles));
  }
  ocultar(texto) {
    return this.opts.apiKey ? texto.split(this.opts.apiKey).join("***") : texto;
  }
  ocultarEn(valor) {
    if (valor === undefined || !this.opts.apiKey)
      return valor;
    return JSON.parse(this.ocultar(JSON.stringify(valor)));
  }
}

// src/config.ts
var BASE_URLS = {
  prod: "https://api.haulmer.com/v2/dte",
  dev: "https://dev-api.haulmer.com/v2/dte"
};

class ConfigError extends Error {
  code = "CONFIG";
}
function resolveConfig(flags, env) {
  const apiKey = (flags.apiKey ?? env.OPENFACTURA_API_KEY ?? env.OPENFACTURA_KEY ?? "").trim();
  if (!apiKey) {
    throw new ConfigError("Falta la API key de OpenFactura. Pásala con --api-key o en la variable OPENFACTURA_API_KEY.");
  }
  const envVar = env.OPENFACTURA_ENV?.trim().toLowerCase();
  if (envVar && envVar !== "prod" && envVar !== "dev") {
    throw new ConfigError(`OPENFACTURA_ENV="${envVar}" no existe. Usa "prod" o "dev".`);
  }
  const ambiente = flags.dev || envVar === "dev" ? "dev" : "prod";
  return { apiKey, env: ambiente, baseUrl: BASE_URLS[ambiente], timeoutMs: flags.timeoutMs ?? 60000 };
}

// src/command.ts
class UsageError extends Error {
  code = "USAGE";
}

class ValidationError extends Error {
  details;
  code = "VALIDATION";
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}
function texto(flags, nombre) {
  const v = flags[nombre];
  return typeof v === "string" ? v : undefined;
}
function requerido(flags, nombre) {
  const v = texto(flags, nombre);
  if (v === undefined || v.trim() === "")
    throw new UsageError(`Falta --${nombre}`);
  return v;
}
function arg(ctx, i, nombre) {
  const v = ctx.args[i];
  if (v === undefined)
    throw new UsageError(`Falta el argumento <${nombre}>`);
  return v;
}

// src/commands/lecturas.ts
import { existsSync, writeFileSync } from "node:fs";

// src/fechas.ts
function fecha(valor, nombre) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor);
  if (!m)
    throw new UsageError(`--${nombre} debe ser AAAA-MM-DD, llegó "${valor}"`);
  const d = new Date(`${valor}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== valor) {
    throw new UsageError(`--${nombre}: "${valor}" no es una fecha que exista`);
  }
  if (Number(m[1]) < 2000 || Number(m[1]) > 2100)
    throw new UsageError(`--${nombre}: el año ${m[1]} está fuera de rango`);
  return valor;
}
function hoy(ahora = new Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora);
}
function periodo(valor) {
  const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(valor);
  if (!m)
    throw new UsageError(`El período debe ser AAAA-MM o AAAA-MM-DD, llegó "${valor}"`);
  const mes = m[2].padStart(2, "0");
  if (Number(mes) < 1 || Number(mes) > 12)
    throw new UsageError(`Mes inválido en "${valor}"`);
  const resultado = { anio: m[1], mes };
  if (m[3] !== undefined) {
    resultado.dia = m[3].padStart(2, "0");
    fecha(`${resultado.anio}-${mes}-${resultado.dia}`, "periodo");
  }
  return resultado;
}
function rutaPeriodo(p) {
  return `${p.anio}/${p.mes}${p.dia ? `/${p.dia}` : ""}`;
}

// src/rut.ts
function digitoVerificador(cuerpo) {
  let suma = 0;
  let factor = 2;
  for (let i = cuerpo.length - 1;i >= 0; i--) {
    suma += Number(cuerpo[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - suma % 11;
  return resto === 11 ? "0" : resto === 10 ? "K" : String(resto);
}
function normalizarRut(entrada) {
  const limpio = entrada.replace(/[.\s]/g, "").toUpperCase();
  const m = /^(\d{1,9})-?([\dK])$/.exec(limpio);
  if (!m)
    throw new UsageError(`"${entrada}" no es un RUT válido`);
  const [, cuerpo, dv] = m;
  if (Number(cuerpo) === 0)
    throw new UsageError(`"${entrada}" no es un RUT válido`);
  if (digitoVerificador(cuerpo) !== dv) {
    throw new UsageError(`El RUT ${entrada} tiene mal el dígito verificador`);
  }
  return `${Number(cuerpo)}-${dv}`;
}
function rutCuerpo(entrada) {
  return Number(normalizarRut(entrada).split("-")[0]);
}

// src/commands/lecturas.ts
var PAUSA_ENTRE_PAGINAS_MS = 350;
var MAX_PAGINAS = 500;
var esperar = (ms) => new Promise((r) => setTimeout(r, ms));
function entero(valor, nombre) {
  if (valor === undefined || !/^\d+$/.test(valor.trim()))
    throw new UsageError(`${nombre} debe ser un número entero, llegó "${valor}"`);
  return Number(valor);
}
async function rutEmisor(ctx) {
  const dado = texto(ctx.flags, "rut");
  if (dado)
    return normalizarRut(dado);
  const org = await ctx.client.get("/organization");
  if (!org?.rut)
    throw new ApiError("OpenFactura no devolvió el RUT del emisor", 0, "SIN_EMISOR");
  return normalizarRut(org.rut);
}
function enSeco(ctx, accion, endpoint, body, ejecutar) {
  if (ctx.flags.confirmar)
    return ejecutar();
  return {
    enSeco: true,
    accion,
    endpoint,
    body,
    aviso: "No se envió nada. Revisa los datos y repite el comando con --confirmar para ejecutarlo."
  };
}
var CONFIRMAR = { confirmar: { type: "boolean" } };
function rango(flags, desde, hasta, exacta) {
  const r = {};
  const d = texto(flags, desde);
  const h = texto(flags, hasta);
  const e = exacta ? texto(flags, exacta) : undefined;
  if (e)
    r.eq = fecha(e, exacta);
  if (d)
    r.gte = fecha(d, desde);
  if (h)
    r.lte = fecha(h, hasta);
  return Object.keys(r).length ? r : undefined;
}
async function listar(ctx, ruta, filtros) {
  const folio = texto(ctx.flags, "folio");
  const todas = Boolean(ctx.flags.todas) || folio !== undefined;
  let pagina = texto(ctx.flags, "pagina") ? entero(texto(ctx.flags, "pagina"), "--pagina") : 1;
  if (pagina < 1)
    throw new UsageError("--pagina parte en 1");
  if (folio !== undefined && texto(ctx.flags, "pagina"))
    throw new UsageError("--folio recorre todas las páginas: no se combina con --pagina");
  const documentos = [];
  let ultima = 0;
  let total = 0;
  for (;; ) {
    const body = pagina > 1 ? { ...filtros, Page: pagina } : filtros;
    const r = await ctx.client.post(ruta, body);
    if (!r)
      break;
    documentos.push(...r.data ?? []);
    const ultimaInformada = Number(r.last_page ?? pagina);
    ultima = Number.isInteger(ultimaInformada) && ultimaInformada >= 0 ? ultimaInformada : pagina;
    const totalInformado = Number(r.total ?? documentos.length);
    total = Number.isFinite(totalInformado) ? totalInformado : documentos.length;
    if (!todas || pagina >= ultima || pagina >= MAX_PAGINAS)
      break;
    pagina++;
    await esperar(PAUSA_ENTRE_PAGINAS_MS);
  }
  if (folio !== undefined) {
    const buscado = entero(folio, "--folio");
    const filtrados = documentos.filter((d) => Number(d.Folio) === buscado);
    return { total: filtrados.length, paginas: ultima, pagina: 1, documentos: filtrados };
  }
  return { total, paginas: ultima, pagina: todas ? 1 : pagina, documentos };
}
var FLAGS_LISTA = {
  desde: { type: "string" },
  hasta: { type: "string" },
  fecha: { type: "string" },
  tipo: { type: "string" },
  folio: { type: "string" },
  pagina: { type: "string" },
  todas: { type: "boolean" }
};
function filtroTipo(flags) {
  const t = texto(flags, "tipo");
  return t === undefined ? {} : { TipoDTE: { eq: entero(t, "--tipo") } };
}
var ACCIONES_DOCUMENTO = ["estado", "json", "xml", "pdf", "cedible"];
var VALOR_API = {
  estado: "status",
  json: "json",
  xml: "xml",
  pdf: "pdf",
  cedible: "cedible"
};
function guardarArchivo(ruta, bytes, forzar) {
  if (existsSync(ruta) && !forzar)
    throw new UsageError(`Ya existe ${ruta}. Usa --salida con otro nombre o --sobrescribir`);
  writeFileSync(ruta, bytes);
  return { archivo: ruta, bytes: bytes.length };
}
async function documento(ctx) {
  const accion = arg(ctx, 0, "acción");
  if (!ACCIONES_DOCUMENTO.includes(accion))
    throw new UsageError(`Acción "${accion}" no existe. Usa: ${ACCIONES_DOCUMENTO.join(", ")}`);
  const valor = VALOR_API[accion];
  const token = texto(ctx.flags, "token");
  let ruta;
  let nombreBase;
  if (token) {
    if (ctx.args.length > 1)
      throw new UsageError("Con --token no van tipo ni folio");
    if (!/^[A-Za-z0-9]+$/.test(token))
      throw new UsageError("--token sólo admite letras y números");
    ruta = `/document/${token}/${valor}`;
    nombreBase = token.slice(0, 16);
  } else {
    const tipo = entero(arg(ctx, 1, "tipo"), "<tipo>");
    const folio = entero(arg(ctx, 2, "folio"), "<folio>");
    const rut = await rutEmisor(ctx);
    ruta = `/document/${rut}/${tipo}/${folio}/${valor}`;
    nombreBase = `${rut}_${tipo}_${folio}`;
  }
  const r = await ctx.client.get(ruta);
  if (accion === "estado" || accion === "json")
    return r;
  const campo = accion === "xml" ? "xml" : "pdf";
  const b64 = r?.[campo];
  if (typeof b64 !== "string" || b64 === "")
    throw new ApiError(`OpenFactura no devolvió el campo ${campo}`, 0, "SIN_ARCHIVO");
  if (!/^[A-Za-z0-9+/\s]+={0,2}\s*$/.test(b64))
    throw new ApiError(`OpenFactura devolvió un ${campo} que no es base64`, 0, "ARCHIVO_INVALIDO");
  const bytes = Buffer.from(b64, "base64");
  if (campo === "pdf" && bytes.subarray(0, 4).toString("latin1") !== "%PDF") {
    throw new ApiError("Lo que devolvió OpenFactura no es un PDF", 0, "PDF_INVALIDO");
  }
  const sufijo = accion === "cedible" ? "_cedible.pdf" : accion === "xml" ? ".xml" : ".pdf";
  return guardarArchivo(texto(ctx.flags, "salida") ?? `${nombreBase}${sufijo}`, bytes, Boolean(ctx.flags.sobrescribir));
}
var ESTADOS_COMPRA = {
  pendiente: "pending",
  registrado: "registered",
  excluido: "exclude",
  reclamado: "reclaimed"
};
var ACUSES = ["ACD", "RCD", "ERM", "RFP", "RFT"];
var LECTURAS = [
  {
    nombre: "emisor",
    maxArgs: 0,
    resumen: "Datos de la empresa emisora dueña de la API key",
    uso: `openfactura emisor [--logo]

  --logo  Incluye el logo de la empresa en base64`,
    flags: { logo: { type: "boolean" } },
    run: ({ client, flags }) => client.get(flags.logo ? "/organization?extra_fields=logo" : "/organization")
  },
  {
    nombre: "folios",
    maxArgs: 0,
    resumen: "Tipos de documento autorizados y folios disponibles",
    uso: [
      "openfactura folios",
      "",
      "Ojo: OpenFactura repone los folios sola y este contador se ha visto quieto después de emitir.",
      "Sirve para saber qué tipos de documento están autorizados, no como semáforo de folios."
    ].join(`
`),
    run: ({ client }) => client.get("/organization/document")
  },
  {
    nombre: "contribuyente",
    maxArgs: 1,
    resumen: "Ficha del SII de cualquier RUT: razón social, giro, dirección y sucursales",
    uso: [
      "openfactura contribuyente <rut>",
      "",
      "Agrega dos campos calculados, porque la API responde 200 aunque el RUT no exista:",
      "  encontrado  false si el SII no devolvió razón social ni dirección",
      "  tieneGiro   false si no tiene actividad económica: a ese RUT se le emite boleta, no factura"
    ].join(`
`),
    run: async (ctx) => {
      const rut = normalizarRut(arg(ctx, 0, "rut"));
      const crudo = await ctx.client.get(`/taxpayer/${rut}`);
      if (crudo !== null && (typeof crudo !== "object" || Array.isArray(crudo))) {
        throw new ApiError("OpenFactura devolvió algo que no es la ficha del contribuyente", 0, "RESPUESTA_INVALIDA");
      }
      const r = crudo ?? {};
      const actividades = Array.isArray(r.actividades) ? r.actividades : [];
      const encontrado = Boolean(r.razonSocial || r.direccion);
      const tieneGiro = actividades.some((a) => a.giro || a.codigoActividadEconomica || a.actividadEconomica);
      return { encontrado, tieneGiro, ...r };
    }
  },
  {
    nombre: "documento",
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
      "emitido es normal ver Sin estado unos minutos; si dura horas, algo anda mal."
    ].join(`
`),
    flags: {
      rut: { type: "string" },
      token: { type: "string" },
      salida: { type: "string" },
      sobrescribir: { type: "boolean" }
    },
    run: documento
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
      "           Recorre todas las páginas, así que conviene acotar con --tipo y fechas."
    ].join(`
`),
    flags: { ...FLAGS_LISTA, "rut-receptor": { type: "string" } },
    run: (ctx) => {
      const filtros = { ...filtroTipo(ctx.flags) };
      const f = rango(ctx.flags, "desde", "hasta", "fecha");
      if (f)
        filtros.FchEmis = f;
      const rut = texto(ctx.flags, "rut-receptor");
      if (rut)
        filtros.RUTRecep = { eq: rutCuerpo(rut) };
      return listar(ctx, "/document/issued", filtros);
    }
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
      "                               que llegan con fecha de emisión atrasada"
    ].join(`
`),
    flags: {
      ...FLAGS_LISTA,
      "rut-emisor": { type: "string" },
      "recepcion-desde": { type: "string" },
      "recepcion-hasta": { type: "string" }
    },
    run: (ctx) => {
      const filtros = { ...filtroTipo(ctx.flags) };
      const f = rango(ctx.flags, "desde", "hasta", "fecha");
      if (f)
        filtros.FchEmis = f;
      const r = rango(ctx.flags, "recepcion-desde", "recepcion-hasta");
      if (r)
        filtros.FchRecepOF = r;
      const rut = texto(ctx.flags, "rut-emisor");
      if (rut)
        filtros.RUTEmisor = { eq: rutCuerpo(rut) };
      return listar(ctx, "/document/received", filtros);
    }
  },
  {
    nombre: "acusar",
    maxArgs: 2,
    resumen: "Acepta o reclama un documento recibido ante el SII (pide --confirmar)",
    uso: [
      "openfactura acusar <tipo> <folio> --rut-emisor <rut> --acuse <ACD|RCD|ERM|RFP|RFT> [--confirmar]",
      "",
      "  ACD  Acepta el contenido      RCD  Reclama el contenido",
      "  ERM  Recibo de mercaderías    RFP  Reclamo por falta parcial    RFT  Reclamo por falta total",
      "",
      "Queda registrado en el SII y no se deshace. Sin --confirmar sólo muestra lo que enviaría."
    ].join(`
`),
    flags: { "rut-emisor": { type: "string" }, acuse: { type: "string" }, ...CONFIRMAR },
    run: (ctx) => {
      const acuse = requerido(ctx.flags, "acuse").toUpperCase();
      if (!ACUSES.includes(acuse))
        throw new UsageError(`--acuse debe ser uno de ${ACUSES.join(", ")}`);
      const body = {
        dte: entero(arg(ctx, 0, "tipo"), "<tipo>"),
        folio: entero(arg(ctx, 1, "folio"), "<folio>"),
        rut: normalizarRut(requerido(ctx.flags, "rut-emisor")),
        acuse
      };
      return enSeco(ctx, "acusar documento recibido", "POST /document/received/accuse", body, () => ctx.client.post("/document/received/accuse", body));
    }
  },
  {
    nombre: "ventas",
    maxArgs: 1,
    resumen: "Resumen del registro de ventas de un mes o un día, por tipo de documento",
    uso: "openfactura ventas <AAAA-MM | AAAA-MM-DD>",
    run: (ctx) => ctx.client.get(`/registry/sales/${rutaPeriodo(periodo(arg(ctx, 0, "período")))}`)
  },
  {
    nombre: "compras",
    maxArgs: 1,
    resumen: "Resumen del registro de compras de un mes o un día, separado por estado",
    uso: [
      "openfactura compras <AAAA-MM | AAAA-MM-DD> [--estado pendiente,registrado,excluido,reclamado]"
    ].join(`
`),
    flags: { estado: { type: "string" } },
    run: (ctx) => {
      let ruta = `/registry/purchase/${rutaPeriodo(periodo(arg(ctx, 0, "período")))}`;
      const estado = texto(ctx.flags, "estado");
      if (estado) {
        const valores = estado.split(",").map((e) => {
          const v = ESTADOS_COMPRA[e.trim().toLowerCase()];
          if (!v)
            throw new UsageError(`--estado: "${e}" no existe. Usa ${Object.keys(ESTADOS_COMPRA).join(", ")}`);
          return v;
        });
        ruta += `?status=${encodeURIComponent(valores.join(","))}`;
      }
      return ctx.client.get(ruta);
    }
  },
  {
    nombre: "sincronizar-rcv",
    maxArgs: 2,
    resumen: "Pide a OpenFactura traer del SII el registro de compras o ventas de un mes",
    uso: [
      "openfactura sincronizar-rcv <ventas|compras> <AAAA-MM>",
      "",
      "Queda en cola y no devuelve datos. Tiene su propio límite: si responde OF-429, espera los",
      "segundos de retry_after antes de volver a pedirlo."
    ].join(`
`),
    run: (ctx) => {
      const registro = { ventas: "sales", compras: "purchase" }[arg(ctx, 0, "ventas|compras")];
      if (!registro)
        throw new UsageError("El registro debe ser ventas o compras");
      const p = periodo(arg(ctx, 1, "período"));
      if (p.dia)
        throw new UsageError("El período va sin día: AAAA-MM");
      return ctx.client.post("/registry/sync-rcv", { registro, periodo: Number(`${p.anio}${p.mes}`) });
    }
  },
  {
    nombre: "anular-guia",
    maxArgs: 1,
    resumen: "Anula una guía de despacho (52) ante el SII (pide --confirmar)",
    uso: [
      "openfactura anular-guia <folio> --fecha <AAAA-MM-DD> [--confirmar]",
      "",
      "  --fecha  Fecha de emisión de la guía",
      "",
      "Es el único tipo de documento que la API permite anular. Una factura o boleta se corrige con",
      "una nota de crédito. Sin --confirmar sólo muestra lo que enviaría."
    ].join(`
`),
    flags: { fecha: { type: "string" }, ...CONFIRMAR },
    run: (ctx) => {
      const body = { Dte: 52, Folio: entero(arg(ctx, 0, "folio"), "<folio>"), Fecha: fecha(requerido(ctx.flags, "fecha"), "fecha") };
      return enSeco(ctx, "anular guía de despacho", "POST /anularDTE52", body, () => ctx.client.post("/anularDTE52", body));
    }
  }
];

// src/commands/emitir.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync2, readFileSync, statSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname, resolve } from "node:path";

// src/dte/items.ts
var MAX_NOMBRE_ITEM = 80;
var MAX_DECIMALES = 6;
var MAX_MONTO = 999999999999;
var GUIONES_LARGOS = /[‒–—―−]/g;
var CAMPOS_JSON = new Set(["nombre", "cantidad", "precio", "exento", "descripcion"]);
var FORMATO = 'Cada --item va como "nombre|cantidad|precio" (agrega "|exento" si corresponde) o como JSON: ' + '{"nombre":"...","cantidad":1,"precio":1000,"exento":false,"descripcion":"..."}';
function numeroEstricto(valor, campo, prefijo) {
  let n;
  if (typeof valor === "number") {
    n = valor;
  } else if (typeof valor === "string") {
    const t = valor.trim();
    if (/^[1-9]\d{0,2}([.,]\d{3})+$/.test(t)) {
      throw new ValidationError(`${prefijo}: ${campo} "${valor}" es ambiguo. Escribe el número sin separador de miles: ${t.replace(/[.,]/g, "")}`);
    }
    if (!/^\d+([.,]\d+)?$/.test(t))
      throw new ValidationError(`${prefijo}: ${campo} "${valor}" no es un número. ${FORMATO}`);
    n = Number(t.replace(",", "."));
  } else {
    throw new ValidationError(`${prefijo}: falta ${campo}. ${FORMATO}`);
  }
  if (!Number.isFinite(n) || n < 0)
    throw new ValidationError(`${prefijo}: ${campo} "${valor}" no es un número válido`);
  const decimales = (String(n).split(".")[1] ?? "").length;
  if (decimales > MAX_DECIMALES || String(n).includes("e")) {
    throw new ValidationError(`${prefijo}: ${campo} admite hasta ${MAX_DECIMALES} decimales y un tamaño razonable`);
  }
  if (n > MAX_MONTO)
    throw new ValidationError(`${prefijo}: ${campo} ${valor} es demasiado grande`);
  return n;
}
function limpiarNombre(nombre, i, avisos) {
  const sinGuiones = nombre.replace(GUIONES_LARGOS, "-");
  if (sinGuiones !== nombre)
    avisos.push(`Ítem ${i}: se cambió el guion largo por uno corto, porque OpenFactura lo borra`);
  const limpio = sinGuiones.replace(/\s{2,}/g, " ").trim();
  if (!limpio)
    throw new ValidationError(`Ítem ${i}: falta el nombre. ${FORMATO}`);
  if (limpio.length > MAX_NOMBRE_ITEM) {
    throw new ValidationError(`Ítem ${i}: el nombre tiene ${limpio.length} caracteres y el máximo es ${MAX_NOMBRE_ITEM}. Pon el detalle en "descripcion"`);
  }
  return limpio;
}
function parsearItem(texto2, i, avisos) {
  const t = texto2.trim();
  const prefijo = `Ítem ${i}`;
  if (t.startsWith("{")) {
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      throw new ValidationError(`${prefijo}: el JSON no es válido. ${FORMATO}`);
    }
    const desconocidos = Object.keys(o).filter((k) => !CAMPOS_JSON.has(k));
    if (desconocidos.length) {
      throw new ValidationError(`${prefijo}: campos desconocidos ${desconocidos.join(", ")}. Los válidos son ${[...CAMPOS_JSON].join(", ")}`);
    }
    if (o.exento !== undefined && typeof o.exento !== "boolean")
      throw new ValidationError(`${prefijo}: "exento" debe ser true o false, sin comillas`);
    if (o.descripcion !== undefined && typeof o.descripcion !== "string")
      throw new ValidationError(`${prefijo}: "descripcion" debe ser texto`);
    const linea = {
      nombre: limpiarNombre(String(o.nombre ?? ""), i, avisos),
      cantidad: numeroEstricto(o.cantidad ?? 1, "la cantidad", prefijo),
      precio: numeroEstricto(o.precio, "el precio", prefijo),
      exento: o.exento === true
    };
    if (typeof o.descripcion === "string" && o.descripcion.trim())
      linea.descripcion = o.descripcion.trim();
    return linea;
  }
  const partes = t.split("|").map((p) => p.trim());
  if (partes.length < 3 || partes.length > 4)
    throw new ValidationError(`${prefijo}: "${texto2}" no tiene el formato esperado. ${FORMATO}`);
  const [nombre, cantidad, precio, marca] = partes;
  if (marca !== undefined && marca.toLowerCase() !== "exento") {
    throw new ValidationError(`${prefijo}: el cuarto campo sólo puede ser "exento". ${FORMATO}`);
  }
  return {
    nombre: limpiarNombre(nombre, i, avisos),
    cantidad: numeroEstricto(cantidad, "la cantidad", prefijo),
    precio: numeroEstricto(precio, "el precio", prefijo),
    exento: marca !== undefined
  };
}

// src/dte/partes.ts
var MAX_GIRO_RECEPTOR = 40;
var RECEPTOR_CONSUMIDOR_FINAL = {
  RUTRecep: "66666666-6",
  RznSocRecep: "Cliente",
  DirRecep: "Sin direccion",
  CmnaRecep: "Santiago"
};
var limpio = (v) => typeof v === "string" ? v.replace(/\s{2,}/g, " ").trim() : "";
function actividades(ficha) {
  return Array.isArray(ficha.actividades) ? ficha.actividades : [];
}
function principal(ficha) {
  const lista = actividades(ficha).filter((a) => a.giro || a.codigoActividadEconomica);
  return lista.find((a) => a.actividadPrincipal) ?? lista[0];
}
function emisorDesdeOrganizacion(org, esBoleta, acteco) {
  const rut = limpio(org.rut);
  const razon = limpio(org.razonSocial);
  const giro = limpio(org.glosaDescriptiva) || limpio(principal(org)?.giro);
  const dir = limpio(org.direccion);
  const comuna = limpio(org.comuna);
  const faltan = [!rut && "rut", !razon && "razón social", !giro && "giro", !dir && "dirección", !comuna && "comuna"].filter(Boolean);
  if (faltan.length)
    throw new ValidationError(`OpenFactura no devolvió estos datos del emisor: ${faltan.join(", ")}`);
  const sucursal = limpio(org.cdgSIISucur);
  if (esBoleta) {
    return { RUTEmisor: rut, RznSocEmisor: razon, GiroEmisor: giro, DirOrigen: dir, CmnaOrigen: comuna, ...sucursal ? { CdgSIISucur: sucursal } : {} };
  }
  const codigo = acteco ?? Number(principal(org)?.codigoActividadEconomica);
  if (!Number.isInteger(codigo) || codigo <= 0) {
    throw new ValidationError("No se encontró la actividad económica del emisor. Pásala con --acteco <código>");
  }
  return { RUTEmisor: rut, RznSoc: razon, GiroEmis: giro, Acteco: codigo, DirOrigen: dir, CmnaOrigen: comuna, ...sucursal ? { CdgSIISucur: sucursal } : {} };
}
function receptorDesdeFicha(rut, ficha, manual, esBoleta, avisos) {
  const encontrado = Boolean(ficha.razonSocial || ficha.direccion);
  const razon = manual.razonSocial ?? limpio(ficha.razonSocial);
  const direccion = manual.direccion ?? limpio(ficha.direccion);
  const comuna = manual.comuna ?? limpio(ficha.comuna);
  if (!razon) {
    throw new ValidationError(encontrado ? `El SII no trae razón social para ${rut}. Pásala con --razon-social` : `El SII no conoce el RUT ${rut}. Revisa el RUT o pasa los datos a mano con --razon-social, --direccion y --comuna`);
  }
  const receptor = { RUTRecep: rut, RznSocRecep: razon };
  if (!esBoleta) {
    let giro = manual.giro ?? limpio(principal(ficha)?.giro);
    if (!giro) {
      throw new ValidationError(`${razon} (${rut}) no tiene giro en el SII, así que no puede recibir factura: emítele una boleta. ` + "Si sabes que sí tiene giro, pásalo con --giro");
    }
    if (giro.length > MAX_GIRO_RECEPTOR) {
      avisos.push(`El giro del receptor se recortó a ${MAX_GIRO_RECEPTOR} caracteres, que es lo que admite el SII`);
      giro = giro.slice(0, MAX_GIRO_RECEPTOR);
    }
    receptor.GiroRecep = giro;
    if (manual.contacto)
      receptor.Contacto = manual.contacto;
  }
  if (!direccion || !comuna)
    throw new ValidationError(`Faltan la dirección o la comuna de ${razon}. Pásalas con --direccion y --comuna`);
  receptor.DirRecep = direccion;
  receptor.CmnaRecep = comuna;
  if (manual.correo)
    receptor.CorreoRecep = manual.correo;
  return receptor;
}

// src/dte/totales.ts
var TASA_IVA = 19;
var MAX_MONTO_DOCUMENTO = 999999999999999;
var FACTOR = 1 + TASA_IVA / 100;
function validar(lineas) {
  if (lineas.length === 0)
    throw new ValidationError("El documento necesita al menos una línea de detalle (--item)");
  lineas.forEach((l, i) => {
    if (!(l.cantidad > 0))
      throw new ValidationError(`Línea ${i + 1}: la cantidad debe ser mayor que cero`);
    if (!(l.precio >= 0) || !Number.isFinite(l.precio))
      throw new ValidationError(`Línea ${i + 1}: el precio no puede ser negativo`);
  });
}
var suma = (ls) => ls.reduce((n, l) => n + l.monto, 0);
function calcularTotales(modo, entrada, opciones = {}) {
  validar(entrada);
  const avisos = [];
  const base = entrada.map((l) => {
    const exento = modo === "exento" ? true : l.exento;
    const precio = modo === "neto" && opciones.preciosConIva && !exento ? Math.round(l.precio / FACTOR * 1e6) / 1e6 : l.precio;
    return { ...l, exento, precio };
  });
  const lineas = base.map((l) => ({ ...l, monto: Math.round(l.cantidad * l.precio) }));
  lineas.forEach((l, i) => {
    if (!Number.isSafeInteger(l.monto) || l.monto > MAX_MONTO_DOCUMENTO) {
      throw new ValidationError(`Línea ${i + 1}: el monto (cantidad por precio) es demasiado grande`);
    }
  });
  const exentas = suma(lineas.filter((l) => l.exento));
  const afectas = suma(lineas.filter((l) => !l.exento));
  let totales;
  if (modo === "exento") {
    totales = { MntExe: exentas, MntTotal: exentas };
  } else if (modo === "bruto") {
    const neto = Math.round(afectas / FACTOR);
    totales = { MntNeto: neto, ...exentas ? { MntExe: exentas } : {}, IVA: afectas - neto, MntTotal: afectas + exentas };
  } else {
    const iva = Math.round(afectas * (TASA_IVA / 100));
    totales = { MntNeto: afectas, ...exentas ? { MntExe: exentas } : {}, IVA: iva, MntTotal: afectas + exentas + iva };
    if (opciones.preciosConIva) {
      const pedido = Math.round(entrada.reduce((n, l) => n + l.cantidad * l.precio, 0));
      if (pedido !== totales.MntTotal) {
        avisos.push(`Los precios con IVA suman ${pedido}, pero al desglosarlos el total queda en ${totales.MntTotal}. ` + "El SII calcula el IVA sobre el neto, así que no todo precio bruto tiene un neto exacto.");
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

// src/commands/emitir.ts
var TIPOS = {
  factura: { codigo: 33, modo: "neto", boleta: false, receptor: "obligatorio", nota: false, guia: false },
  "factura-exenta": { codigo: 34, modo: "exento", boleta: false, receptor: "obligatorio", nota: false, guia: false },
  boleta: { codigo: 39, modo: "bruto", boleta: true, receptor: "opcional", nota: false, guia: false },
  "boleta-exenta": { codigo: 41, modo: "exento", boleta: true, receptor: "opcional", nota: false, guia: false },
  "nota-credito": { codigo: 61, modo: "neto", boleta: false, receptor: "opcional", nota: true, guia: false },
  "nota-debito": { codigo: 56, modo: "neto", boleta: false, receptor: "opcional", nota: true, guia: false },
  guia: { codigo: 52, modo: "neto", boleta: false, receptor: "obligatorio", nota: false, guia: true }
};
var REFERENCIABLES = {
  61: [33, 34, 39, 41, 43, 46, 56],
  56: [33, 34, 43, 46, 61]
};
var TIPOS_BOLETA = new Set([39, 41]);
var TIPOS_EXENTOS = new Set([34, 41]);
var FORMA_PAGO = { contado: 1, credito: 2, "sin-costo": 3 };
var MEDIO_PAGO_BOLETA = { efectivo: 1, electronico: 2, transferencia: 3, cheque: 4, otro: 5 };
var TRASLADO = {
  venta: 1,
  "venta-por-efectuar": 2,
  consignacion: 3,
  "entrega-gratuita": 4,
  interno: 5,
  "otro-traslado": 6,
  devolucion: 7,
  "traslado-exportacion": 8,
  "venta-exportacion": 9
};
var DESPACHO = { receptor: 1, "emisor-cliente": 2, "emisor-otro": 3 };
var CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var VIGENCIA_RES_154 = "2026-11-01";
var UMBRAL_BOLETA_IDENTIFICADA = 5000000;
var MESES_PLAZO_REBAJA = 6;
var MAX_NMB_ITEM = 80;
var MAX_RAZON_REF = 90;
var MAX_ESPERA_S = 3600;
var MAX_PAGINAS_NOTAS = 10;
function opcion(mapa, valor, flag) {
  if (valor === undefined)
    return;
  const v = mapa[valor.toLowerCase()];
  if (v === undefined)
    throw new UsageError(`--${flag}: "${valor}" no existe. Usa ${Object.keys(mapa).join(", ")}`);
  return v;
}
function correo(ctx) {
  const c = texto(ctx.flags, "correo");
  if (c !== undefined && !CORREO.test(c))
    throw new UsageError(`--correo: "${c}" no parece un correo`);
  return c;
}
function lista(ctx, nombre) {
  return ctx.flags[nombre] ?? [];
}
function detalle(lineas) {
  return lineas.map((l, i) => ({
    NroLinDet: i + 1,
    NmbItem: l.nombre,
    ...l.descripcion ? { DscItem: l.descripcion } : {},
    QtyItem: l.cantidad,
    PrcItem: l.precio,
    MontoItem: l.monto,
    ...l.exento ? { IndExe: 1 } : {}
  }));
}
function numeros(t) {
  const r = {};
  for (const k of ["MntNeto", "MntExe", "IVA", "MntTotal"])
    if (t[k] !== undefined && t[k] !== null && t[k] !== "")
      r[k] = Number(t[k]);
  return r;
}
function totalesDte(totales, tipo, modo) {
  const t = numeros(totales);
  if (modo === "exento")
    return { MntExe: t.MntExe ?? t.MntTotal ?? 0, MntTotal: t.MntTotal ?? 0 };
  if (tipo.boleta)
    return t;
  return { MntNeto: t.MntNeto ?? 0, ...t.MntExe ? { MntExe: t.MntExe } : {}, TasaIVA: TASA_IVA, IVA: t.IVA ?? 0, MntTotal: t.MntTotal ?? 0 };
}
function restarMeses(fechaIso, meses) {
  const [a, m, d] = fechaIso.split("-").map(Number);
  const total = a * 12 + (m - 1) - meses;
  const anio = Math.floor(total / 12);
  const mes = total % 12 + 1;
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${anio}-${String(mes).padStart(2, "0")}-${String(Math.min(d, ultimo)).padStart(2, "0")}`;
}
function totalesOriginales(totales, modo) {
  if (!totales || typeof totales !== "object")
    throw new ValidationError("El documento original no trae totales");
  const t = {};
  for (const k of ["MntNeto", "MntExe", "IVA", "MntTotal"]) {
    if (totales[k] === undefined || totales[k] === null || totales[k] === "")
      continue;
    const n = typeof totales[k] === "number" ? totales[k] : /^\d+$/.test(String(totales[k]).trim()) ? Number(totales[k]) : NaN;
    if (!Number.isFinite(n))
      throw new ValidationError(`El documento original trae ${k} = "${totales[k]}", que no es un monto`);
    t[k] = n;
  }
  if (t.MntTotal === undefined)
    throw new ValidationError("El documento original no trae MntTotal");
  if (modo === "bruto" && (t.MntNeto === undefined || t.IVA === undefined)) {
    const afecto = t.MntTotal - (t.MntExe ?? 0);
    t.MntNeto = Math.round(afecto / (1 + TASA_IVA / 100));
    t.IVA = afecto - t.MntNeto;
  }
  return t;
}
async function referenciaNota(ctx, tipo, rutPropio) {
  const ref = texto(ctx.flags, "referencia");
  if (!ref)
    throw new UsageError('Falta --referencia <tipo>:<folio> del documento que se corrige, por ejemplo "33:30"');
  const m = /^(\d+):(\d+)$/.exec(ref.trim());
  if (!m)
    throw new UsageError(`--referencia debe ser <tipo>:<folio>, llegó "${ref}"`);
  const tipoRef = Number(m[1]);
  const folio = Number(m[2]);
  if (tipo.codigo === 56 && TIPOS_BOLETA.has(tipoRef)) {
    throw new ValidationError("No se emite nota de débito sobre una boleta. Para cobrar más sobre una boleta se emite una boleta nueva que referencia a la primera (Res. Ex. SII 74/2020)");
  }
  if (tipo.codigo === 61 && tipoRef === 61) {
    throw new ValidationError("Una nota de crédito no se revierte con otra nota de crédito: corresponde una nota de débito que la referencie");
  }
  if (!REFERENCIABLES[tipo.codigo].includes(tipoRef)) {
    throw new ValidationError(`Una ${tipo.codigo === 61 ? "nota de crédito" : "nota de débito"} no puede referenciar un documento tipo ${tipoRef}. Tipos válidos: ${REFERENCIABLES[tipo.codigo].join(", ")}`);
  }
  const acciones = [ctx.flags.anula && 1, ctx.flags["corrige-texto"] && 2, ctx.flags["corrige-montos"] && 3].filter(Boolean);
  if (acciones.length !== 1)
    throw new UsageError("Indica exactamente una: --anula, --corrige-montos o --corrige-texto");
  const codRef = acciones[0];
  if (tipo.codigo === 56 && codRef === 1 && tipoRef !== 61) {
    throw new ValidationError("Una nota de débito sólo anula una nota de crédito. Para dejar sin efecto una factura se emite una nota de crédito con --anula");
  }
  const razonDada = texto(ctx.flags, "razon");
  if (codRef === 2 && !razonDada)
    throw new UsageError("--corrige-texto necesita --razon con la corrección");
  const razon = razonDada ?? (codRef === 1 ? "Anula documento" : "Corrige montos");
  if (razon.length > MAX_RAZON_REF)
    throw new ValidationError(`--razon tiene ${razon.length} caracteres y el máximo es ${MAX_RAZON_REF}`);
  if (codRef === 2 && razon.length > MAX_NMB_ITEM) {
    throw new ValidationError(`Con --corrige-texto la razón va también como línea del detalle, que admite ${MAX_NMB_ITEM} caracteres`);
  }
  const r = await ctx.client.get(`/document/${rutPropio}/${tipoRef}/${folio}/json`);
  const original = r?.json;
  if (!original?.Encabezado)
    throw new ValidationError(`No se pudo leer el documento ${tipoRef} folio ${folio} para referenciarlo`);
  const emisorOriginal = original.Encabezado.Emisor?.RUTEmisor;
  if (emisorOriginal && normalizarRut(String(emisorOriginal)) !== rutPropio) {
    throw new ValidationError(`El documento ${tipoRef} folio ${folio} es de otro emisor (${emisorOriginal}). Sólo se corrigen documentos propios`);
  }
  if (!original.Encabezado.Receptor?.RUTRecep) {
    throw new ValidationError(`El documento ${tipoRef} folio ${folio} no trae el RUT del receptor, y la nota tiene que ir al mismo receptor`);
  }
  const fechaOriginal = String(original.Encabezado.IdDoc?.FchEmis ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaOriginal))
    throw new ValidationError(`El documento ${tipoRef} folio ${folio} no trae fecha de emisión`);
  return { tipo: tipoRef, folio, codRef, razon, original, fecha: fechaOriginal };
}
function receptorDeNota(ctx, ref, email) {
  const original = { ...ref.original.Encabezado.Receptor ?? {} };
  const dado = texto(ctx.flags, "receptor");
  if (dado && normalizarRut(dado) !== normalizarRut(String(original.RUTRecep ?? ""))) {
    throw new ValidationError(`El receptor de la nota tiene que ser el mismo del documento que corrige (${original.RUTRecep}). ` + "Si el RUT del original estaba mal, se anula con --anula y se emite un documento nuevo al RUT correcto");
  }
  const reemplazos = {
    RznSocRecep: texto(ctx.flags, "razon-social"),
    GiroRecep: texto(ctx.flags, "giro"),
    DirRecep: texto(ctx.flags, "direccion"),
    CmnaRecep: texto(ctx.flags, "comuna"),
    Contacto: texto(ctx.flags, "contacto"),
    CorreoRecep: email
  };
  for (const [k, v] of Object.entries(reemplazos))
    if (v !== undefined)
      original[k] = v;
  return original;
}
async function referenciasLibres(ctx, rutPropio) {
  const refs = lista(ctx, "ref");
  const salida = [];
  for (const [i, ref] of refs.entries()) {
    const m = /^(\d+):([^:]+)(?::(\d{4}-\d{2}-\d{2}))?$/.exec(ref.trim());
    if (!m)
      throw new UsageError(`--ref debe ser <tipo>:<folio>[:AAAA-MM-DD], llegó "${ref}"`);
    const tipo = Number(m[1]);
    const tributario = tipo < 800;
    const folio = tributario ? entero(m[2], "el folio de --ref") : m[2];
    let fechaRef = m[3];
    if (!fechaRef) {
      if (!tributario)
        throw new UsageError(`--ref ${ref}: un documento tipo ${tipo} necesita la fecha, ej. ${tipo}:${folio}:AAAA-MM-DD`);
      const r = await ctx.client.get(`/document/${rutPropio}/${tipo}/${folio}/json`);
      fechaRef = r?.json?.Encabezado?.IdDoc?.FchEmis;
      if (!fechaRef)
        throw new ValidationError(`No se encontró el documento ${tipo} folio ${folio}. Pasa la fecha: ${tipo}:${folio}:AAAA-MM-DD`);
    }
    salida.push({ NroLinRef: i + 1, TpoDocRef: String(tipo), FolioRef: folio, FchRef: fecha(fechaRef, "ref") });
  }
  return salida;
}
async function notasPrevias(ctx, ref, rutPropio, receptor, avisos) {
  try {
    const suma2 = {};
    const folios = [];
    const filtros = { TipoDTE: { eq: 61 }, FchEmis: { gte: ref.fecha } };
    const rutRecep = Number(normalizarRut(String(receptor.RUTRecep)).split("-")[0]);
    if (rutRecep !== 66666666)
      filtros.RUTRecep = { eq: rutRecep };
    for (let pagina = 1;pagina <= MAX_PAGINAS_NOTAS; pagina++) {
      const r = await ctx.client.post("/document/issued", pagina > 1 ? { ...filtros, Page: pagina } : filtros);
      for (const d of r?.data ?? []) {
        const nc = await ctx.client.get(`/document/${rutPropio}/61/${d.Folio}/json`);
        const refs = nc?.json?.Referencia;
        const lista2 = Array.isArray(refs) ? refs : refs ? [refs] : [];
        const apunta = lista2.some((x) => String(x.TpoDocRef) === String(ref.tipo) && Number(x.FolioRef) === ref.folio && Number(x.CodRef) !== 2);
        if (!apunta)
          continue;
        folios.push(`61:${d.Folio}`);
        const t = numeros(nc.json.Encabezado?.Totales ?? {});
        for (const k of ["MntNeto", "MntExe", "IVA", "MntTotal"])
          suma2[k] = (suma2[k] ?? 0) + (t[k] ?? 0);
      }
      if (!r || pagina >= Number(r.last_page ?? pagina))
        break;
    }
    return { suma: suma2, folios };
  } catch (e) {
    avisos.push(`No se pudo revisar si ya hay otras notas de crédito contra este documento (${e.message}). Revísalo con: openfactura emitidos --tipo 61`);
    return null;
  }
}
function validarAntesDeEmitir(ctx) {
  const clave = texto(ctx.flags, "idempotency-key");
  if (clave !== undefined && clave.trim() === "")
    throw new UsageError("--idempotency-key no puede ir vacía");
  const espera = texto(ctx.flags, "esperar");
  if (espera !== undefined && entero(espera, "--esperar") > MAX_ESPERA_S)
    throw new UsageError(`--esperar es de hasta ${MAX_ESPERA_S} segundos`);
  const intervalo = texto(ctx.flags, "intervalo");
  if (intervalo !== undefined) {
    const n = entero(intervalo, "--intervalo");
    if (n < 1 || n > MAX_ESPERA_S)
      throw new UsageError(`--intervalo va de 1 a ${MAX_ESPERA_S} segundos`);
  }
  const pdf = texto(ctx.flags, "pdf");
  if (pdf !== undefined && pdf.trim() === "")
    throw new UsageError("--pdf necesita el nombre del archivo");
  if (pdf) {
    if (existsSync2(pdf) && !ctx.flags.sobrescribir)
      throw new UsageError(`Ya existe ${pdf}. Usa otro nombre o --sobrescribir`);
    const carpeta = dirname(resolve(pdf));
    if (!existsSync2(carpeta) || !statSync(carpeta).isDirectory())
      throw new UsageError(`No existe la carpeta ${carpeta} para guardar el PDF`);
  }
}
function idempotencia(dte, dada) {
  const contenido = JSON.stringify(dte);
  const base = dada?.trim() ? `${dada.trim()}
${contenido}` : contenido;
  return createHash("sha256").update(base).digest("hex");
}
function tokenDe(detalles) {
  if (!Array.isArray(detalles))
    return null;
  const t = detalles.find((d) => d && typeof d === "object" && d.field === "token");
  return t ? String(t.issue) : null;
}
async function enviar(ctx, dte, extra, resumen, avisos) {
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
      aviso: `No se emitió nada. Revisa el resumen y el DTE, y repite el comando con --confirmar para emitirlo ante el SII${ambiente === "dev" ? " (ambiente de pruebas)" : ""}.`
    };
  }
  const pdf = texto(ctx.flags, "pdf");
  const respuesta = [...extra.respuesta ?? ["FOLIO"]];
  if (pdf && !respuesta.includes("PDF"))
    respuesta.push("PDF");
  const body = { response: respuesta, dte };
  if (extra.correo)
    body.sendEmail = { to: extra.correo };
  let r;
  try {
    r = await ctx.client.post("/document", body, { idempotencyKey: key });
  } catch (e) {
    if (e instanceof ApiError && e.code === "TIMEOUT") {
      const fechaDte = dte.Encabezado?.IdDoc?.FchEmis;
      throw new ApiError(`${e.message}. Para repetirlo exactamente igual aunque cambie el día, agrega --fecha ${fechaDte}` + (texto(ctx.flags, "idempotency-key") ? "" : " y usa el mismo comando"), 0, "TIMEOUT", { idempotencyKey: key, fecha: fechaDte });
    }
    if (e instanceof ApiError && e.code === "OF-06") {
      const token = tokenDe(e.details);
      return {
        emitido: false,
        yaEmitido: true,
        ambiente,
        token,
        mensaje: e.message,
        aviso: "Este mismo documento ya se había enviado (idempotencia). No se emitió uno nuevo. " + (token ? `Consulta el existente con: openfactura documento estado --token ${token}` : "Busca el existente con: openfactura emitidos")
      };
    }
    throw e;
  }
  if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.TOKEN !== "string") {
    throw new ApiError("OpenFactura respondió algo que no es una emisión y no se sabe si el documento se emitió. Repite exactamente el mismo comando: la idempotencia evita emitirlo dos veces", 0, "RESPUESTA_INVALIDA", { idempotencyKey: key, fecha: dte.Encabezado?.IdDoc?.FchEmis });
  }
  const res = r;
  const salida = {
    emitido: true,
    ambiente,
    tipo: dte.Encabezado?.IdDoc?.TipoDTE,
    folio: res.FOLIO ?? null,
    token: res.TOKEN,
    total: dte.Encabezado?.Totales?.MntTotal,
    avisos,
    siguiente: `Consulta si el SII lo aceptó con: openfactura documento estado --token ${res.TOKEN}`
  };
  try {
    if (res.WARNING)
      avisos.push(`OpenFactura avisó: ${typeof res.WARNING === "string" ? res.WARNING : JSON.stringify(res.WARNING)}`);
    if (pdf) {
      const bytes = typeof res.PDF === "string" ? Buffer.from(res.PDF, "base64") : Buffer.alloc(0);
      if (bytes.subarray(0, 4).toString("latin1") === "%PDF") {
        writeFileSync2(pdf, bytes);
        salida.pdf = { archivo: pdf, bytes: bytes.length };
      } else {
        avisos.push("El documento se emitió, pero el PDF no llegó bien. Pídelo con: openfactura documento pdf --token " + res.TOKEN);
      }
    }
  } catch (e) {
    avisos.push(`El documento se emitió, pero no se pudo guardar el PDF: ${e.message}`);
  }
  const espera = texto(ctx.flags, "esperar");
  if (espera !== undefined) {
    try {
      salida.estado = await esperarEstado(ctx, res.TOKEN, entero(espera, "--esperar"));
    } catch (e) {
      avisos.push(`El documento se emitió, pero no se pudo consultar su estado: ${e.message}. Reintenta con: openfactura documento estado --token ${res.TOKEN}`);
    }
  }
  return salida;
}
async function esperarEstado(ctx, token, segundos) {
  const intervalo = texto(ctx.flags, "intervalo") !== undefined ? entero(texto(ctx.flags, "intervalo"), "--intervalo") : 10;
  const limite = Date.now() + segundos * 1000;
  let estado = "Sin estado";
  for (;; ) {
    const r = await ctx.client.get(`/document/${token}/status`);
    estado = String(r?.estado ?? estado);
    if (!["Sin estado", "Pendiente"].includes(estado) || Date.now() >= limite)
      return estado;
    await new Promise((res) => setTimeout(res, intervalo * 1000));
  }
}
async function emitirTipo(ctx, nombre) {
  const tipo = TIPOS[nombre];
  if (!tipo)
    throw new UsageError(`Tipo "${nombre}" no existe. Usa: ${[...Object.keys(TIPOS), "archivo"].join(", ")}`);
  validarAntesDeEmitir(ctx);
  const avisos = [];
  const fechaEmision = fecha(texto(ctx.flags, "fecha") ?? hoy(), "fecha");
  if (fechaEmision > hoy())
    avisos.push(`La fecha de emisión ${fechaEmision} es futura`);
  const email = correo(ctx);
  const entrada = lista(ctx, "item").map((t, i) => parsearItem(t, i + 1, avisos));
  if (!tipo.nota && (ctx.flags["sin-rebaja"] || texto(ctx.flags, "referencia"))) {
    throw new UsageError("--referencia y --sin-rebaja son sólo para notas de crédito y débito. Para citar una guía u orden de compra usa --ref");
  }
  if (tipo.nota && lista(ctx, "ref").length)
    throw new UsageError("En una nota el documento corregido va con --referencia, no con --ref");
  const org = await ctx.client.get("/organization") ?? {};
  const acteco = texto(ctx.flags, "acteco");
  const emisor = emisorDesdeOrganizacion(org, tipo.boleta, acteco ? entero(acteco, "--acteco") : undefined);
  const rutPropio = normalizarRut(String(emisor.RUTEmisor));
  const ref = tipo.nota ? await referenciaNota(ctx, tipo, rutPropio) : undefined;
  const modo = ref ? TIPOS_EXENTOS.has(ref.tipo) ? "exento" : TIPOS_BOLETA.has(ref.tipo) ? "bruto" : "neto" : tipo.modo;
  if (ctx.flags["con-iva"] && modo !== "neto") {
    throw new UsageError("--con-iva es para factura y notas sobre factura. En boleta y en notas sobre boleta el precio ya va con IVA; en documentos exentos no hay IVA");
  }
  const origTotales = ref ? totalesOriginales(ref.original.Encabezado.Totales, modo) : undefined;
  let receptor;
  let fichaReceptor;
  const rutReceptor = texto(ctx.flags, "receptor");
  if (ref) {
    receptor = receptorDeNota(ctx, ref, email);
  } else if (rutReceptor) {
    const rut = normalizarRut(rutReceptor);
    fichaReceptor = await ctx.client.get(`/taxpayer/${rut}`) ?? {};
    const manual = {
      razonSocial: texto(ctx.flags, "razon-social"),
      giro: texto(ctx.flags, "giro"),
      direccion: texto(ctx.flags, "direccion"),
      comuna: texto(ctx.flags, "comuna"),
      contacto: texto(ctx.flags, "contacto"),
      correo: email
    };
    receptor = receptorDesdeFicha(rut, fichaReceptor, manual, tipo.boleta, avisos);
  } else if (tipo.receptor === "opcional") {
    receptor = { ...RECEPTOR_CONSUMIDOR_FINAL, ...email ? { CorreoRecep: email } : {} };
  } else {
    throw new UsageError("Falta --receptor <rut>");
  }
  let det;
  let totales;
  if (ref?.codRef === 1) {
    if (entrada.length)
      throw new UsageError("--anula deja sin efecto el documento completo y no lleva --item. Para rebajar una parte usa --corrige-montos");
    const t = ref.original.Encabezado.Totales ?? {};
    if (t.ImptoReten || t.OtrosImp || t.MntNF || ref.original.DscRcgGlobal) {
      throw new ValidationError("El documento original trae impuestos adicionales, montos no facturables o descuentos globales que --anula no copia. Arma la nota completa con: openfactura emitir archivo");
    }
    det = ref.original.Detalle;
    if (!Array.isArray(det) || det.length === 0)
      throw new ValidationError("El documento original no trae detalle para copiar");
    totales = totalesDte(origTotales, tipo, modo);
  } else if (ref?.codRef === 2) {
    if (entrada.length)
      throw new UsageError("--corrige-texto no lleva --item: la corrección va en --razon");
    det = [{ NroLinDet: 1, NmbItem: ref.razon, QtyItem: 1, PrcItem: 0, MontoItem: 0, ...modo === "exento" ? { IndExe: 1 } : {} }];
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
    const nombres = { MntNeto: "el neto", MntExe: "el monto exento", IVA: "el IVA", MntTotal: "el total" };
    const previas = await notasPrevias(ctx, ref, rutPropio, receptor, avisos);
    const acumulado = (k) => (totales[k] ?? 0) + (previas?.suma[k] ?? 0);
    const excesos = ["MntNeto", "MntExe", "IVA", "MntTotal"].filter((k) => acumulado(k) > (origTotales[k] ?? 0)).map((k) => `${nombres[k]} (${acumulado(k)} contra ${origTotales[k] ?? 0})`);
    if (excesos.length) {
      const ya = previas?.folios.length ? ` Ya hay notas de crédito contra este documento: ${previas.folios.join(", ")}.` : "";
      throw new ValidationError(`La nota de crédito supera lo que tiene el documento que corrige en ${excesos.join(", ")}.${ya}`);
    }
  }
  if (ref) {
    if (fechaEmision < ref.fecha)
      throw new ValidationError(`La nota no puede tener fecha (${fechaEmision}) anterior al documento que corrige (${ref.fecha})`);
    if (tipo.codigo === 61 && ref.codRef !== 2 && ref.fecha < restarMeses(fechaEmision, MESES_PLAZO_REBAJA) && !ctx.flags["sin-rebaja"]) {
      avisos.push(`El documento es de hace más de ${MESES_PLAZO_REBAJA} meses. Si la nota es por una devolución o resciliación, ya no da derecho a rebajar el IVA (DL 825 art. 21 N° 2): emítela con --sin-rebaja. Un descuento posterior no tiene ese plazo`);
    }
  }
  const idDoc = { TipoDTE: tipo.codigo, Folio: 0, FchEmis: fechaEmision };
  if (modo === "bruto" && tipo.nota)
    idDoc.MntBruto = 1;
  if (ctx.flags["sin-rebaja"]) {
    if (tipo.codigo !== 61)
      throw new UsageError("--sin-rebaja es sólo para notas de crédito");
    idDoc.IndNoRebaja = 1;
  }
  if (tipo.boleta) {
    const ind = texto(ctx.flags, "ind-servicio");
    idDoc.IndServicio = ind ? entero(ind, "--ind-servicio") : 3;
    if ((idDoc.IndServicio === 1 || idDoc.IndServicio === 2) && !rutReceptor) {
      throw new ValidationError("Una boleta de servicio periódico es nominativa: indica el cliente con --receptor (Res. Ex. SII 74/2020)");
    }
    const medio = opcion(MEDIO_PAGO_BOLETA, texto(ctx.flags, "medio-pago"), "medio-pago");
    if (medio !== undefined)
      idDoc.MedioPago = medio;
    if (totales.MntTotal > UMBRAL_BOLETA_IDENTIFICADA && (!rutReceptor || medio === undefined)) {
      throw new ValidationError("Una boleta sobre 135 UF exige nombre y RUT del comprador y la forma de pago (Res. Ex. SII 44/2025). " + `Sobre ${UMBRAL_BOLETA_IDENTIFICADA.toLocaleString("es-CL")} pesos el CLI los pide siempre: agrega --receptor y --medio-pago`);
    }
    if (fichaReceptor && Array.isArray(fichaReceptor.actividades) && fichaReceptor.actividades.some((a) => a?.giro)) {
      avisos.push("El receptor tiene giro en el SII. Si compra para su negocio, corresponde factura y no boleta (DL 825 art. 53 letra a)");
    }
  } else {
    const forma = opcion(FORMA_PAGO, texto(ctx.flags, "forma-pago"), "forma-pago");
    if (forma !== undefined)
      idDoc.FmaPago = forma;
  }
  const encabezado = { IdDoc: idDoc, Emisor: emisor, Receptor: receptor };
  if (tipo.guia) {
    const traslado = opcion(TRASLADO, texto(ctx.flags, "traslado"), "traslado");
    if (traslado === undefined)
      throw new UsageError(`La guía necesita --traslado: ${Object.keys(TRASLADO).join(", ")}`);
    const despacho = opcion(DESPACHO, texto(ctx.flags, "despacho"), "despacho");
    idDoc.IndTraslado = traslado;
    if (despacho !== undefined)
      idDoc.TipoDespacho = despacho;
    const transporte = {};
    const limpio2 = (n) => texto(ctx.flags, n)?.trim() || undefined;
    const placa = (n) => limpio2(n)?.toUpperCase().replace(/[\s.-]/g, "") || undefined;
    const patente = placa("patente");
    const carro = placa("patente-carro");
    const trans = limpio2("transportista-rut");
    const choferRut = limpio2("chofer-rut");
    const choferNombre = limpio2("chofer-nombre");
    const dir = limpio2("destino-direccion");
    const cmna = limpio2("destino-comuna");
    if (patente)
      transporte.Patente = patente;
    if (carro)
      transporte.PatenteCarro = carro;
    if (trans)
      transporte.RUTTrans = normalizarRut(trans);
    if (choferRut || choferNombre) {
      transporte.Chofer = { ...choferRut ? { RUTChofer: normalizarRut(choferRut) } : {}, ...choferNombre ? { NombreChofer: choferNombre } : {} };
    }
    if (dir)
      transporte.DirDest = dir;
    if (cmna)
      transporte.CmnaDest = cmna;
    const faltan = [
      !dir && "--destino-direccion",
      !cmna && "--destino-comuna",
      !choferRut && "--chofer-rut",
      !choferNombre && "--chofer-nombre",
      !patente && "--patente",
      !trans && "--transportista-rut"
    ].filter(Boolean);
    if (faltan.length) {
      const mensaje = `La Res. Ex. SII 154/2025 exige en las guías origen, destino, chofer, transportista y patente desde el ${VIGENCIA_RES_154}. Falta: ${faltan.join(", ")}`;
      if (fechaEmision >= VIGENCIA_RES_154)
        throw new ValidationError(mensaje);
      avisos.push(mensaje);
    }
    if (Object.keys(transporte).length)
      encabezado.Transporte = transporte;
    if (traslado === 1 && totales.MntTotal === 0)
      avisos.push("Es una guía de venta con monto cero: revisa los precios, o usa otro --traslado si no es venta");
  }
  encabezado.Totales = totales;
  const dte = { Encabezado: encabezado, Detalle: det };
  if (ref) {
    dte.Referencia = [{ NroLinRef: 1, TpoDocRef: String(ref.tipo), FolioRef: ref.folio, FchRef: ref.fecha, CodRef: ref.codRef, RazonRef: ref.razon }];
  } else {
    const refs = await referenciasLibres(ctx, rutPropio);
    if (refs.length)
      dte.Referencia = refs;
  }
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
    ...ref ? { referencia: `${ref.tipo}:${ref.folio}`, codRef: ref.codRef } : {}
  };
  return enviar(ctx, dte, { correo: email }, resumen, avisos);
}
async function emitirArchivo(ctx) {
  const ruta = arg(ctx, 1, "archivo.json");
  let contenido;
  try {
    contenido = JSON.parse(readFileSync(ruta, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    throw new UsageError(`No se pudo leer ${ruta} como JSON: ${e.message}`);
  }
  if (!contenido || typeof contenido !== "object" || Array.isArray(contenido))
    throw new ValidationError("El archivo debe tener un objeto JSON con el DTE");
  const esBody = "dte" in contenido;
  const dte = esBody ? contenido.dte : contenido;
  const idDoc = dte?.Encabezado?.IdDoc;
  if (!idDoc || !Number.isInteger(Number(idDoc.TipoDTE)))
    throw new ValidationError("El DTE no trae Encabezado.IdDoc.TipoDTE");
  if (idDoc.Folio !== undefined && Number(idDoc.Folio) !== 0) {
    throw new ValidationError("IdDoc.Folio debe ser 0: el folio lo asigna OpenFactura al emitir");
  }
  const email = correo(ctx);
  const correoArchivo = esBody ? contenido.sendEmail?.to : undefined;
  if (correoArchivo !== undefined && !String(correoArchivo).split(",").every((c) => CORREO.test(c.trim()))) {
    throw new ValidationError(`sendEmail.to del archivo no es un correo válido: "${correoArchivo}"`);
  }
  const respuesta = esBody && Array.isArray(contenido.response) ? contenido.response : undefined;
  const resumen = { tipo: Number(idDoc.TipoDTE), archivo: ruta, receptor: dte.Encabezado?.Receptor?.RznSocRecep, total: dte.Encabezado?.Totales?.MntTotal };
  return enviar(ctx, dte, { respuesta, correo: email ?? correoArchivo }, resumen, []);
}
var USO = `openfactura emitir <tipo> [opciones]
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
var EMISION = [
  {
    nombre: "emitir",
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
      "idempotency-key": { type: "string" }
    },
    run: (ctx) => {
      const tipo = arg(ctx, 0, "tipo");
      if (tipo !== "archivo" && ctx.args.length > 1)
        throw new UsageError(`Sobran argumentos: ${ctx.args.slice(1).join(" ")}`);
      return tipo === "archivo" ? emitirArchivo(ctx) : emitirTipo(ctx, tipo);
    }
  }
];

// src/commands/skill.ts
import { mkdirSync, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// skill/SKILL.md
var SKILL_default = `---
name: openfactura
description: Opera OpenFactura (Haulmer) con el CLI \`openfactura\`: emitir facturas, boletas, notas de crédito y débito y guías de despacho ante el SII, consultar el estado de un documento, bajar su PDF o XML, listar emitidos y recibidos, ver el registro de compras y ventas del mes, y buscar la ficha de un RUT. Úsala siempre que alguien pida facturar, boletear, emitir o anular un documento tributario electrónico (DTE) en Chile, revisar si el SII aceptó un documento, o consultar ventas, compras o datos de un contribuyente con OpenFactura.
---

# OpenFactura con el CLI \`openfactura\`

El CLI envuelve la API de OpenFactura con las trampas ya resueltas. **Nunca armes llamadas HTTP a mano**:
si algo no está en el CLI, usa \`openfactura emitir archivo\` o dile al usuario que falta.

## Antes de empezar

1. Revisa que esté instalado: \`openfactura --version\`. Si no está, pide instalarlo (ver README del repo).
2. La API key va en la variable \`OPENFACTURA_API_KEY\`. **Nunca la escribas en un comando, un archivo
   versionado ni en tu respuesta.** Si falta, pídele al usuario que la configure él.
3. \`openfactura emisor\` confirma con qué empresa se está operando. Hazlo al principio de cada sesión y
   dile al usuario el nombre y el RUT del emisor antes de emitir nada.
4. Para probar sin consecuencias existe \`--dev\`, que usa el ambiente de pruebas de OpenFactura. Ahí
   sirve la clave demo pública \`928e15a2d14d4a6292345f04960f4bd3\`, del emisor de pruebas de Haulmer.

Todo sale en JSON por stdout. Los errores salen en JSON por stderr: código de salida \`1\` si los rechazó
OpenFactura o el SII, \`2\` si el problema está en los argumentos. \`openfactura <comando> --help\` tiene
todas las opciones.

## La regla que no se rompe: emitir es en seco hasta que el usuario diga que sí

Un documento emitido es evidencia tributaria y no se borra. Se corrige con otra emisión, una nota de
crédito. Por eso:

1. Corre \`openfactura emitir ...\` **sin** \`--confirmar\`. Arma el DTE, calcula los totales y no manda nada.
2. Muéstrale al usuario el \`resumen\`: tipo, receptor, RUT, neto, IVA, total y líneas. Muéstrale también los
   \`avisos\`, y el receptor completo si lo sacaste de la ficha del SII.
3. Emite con \`--confirmar\` sólo cuando el usuario apruebe **ese** resumen. Un "dale" dicho antes de ver
   los montos no cuenta.
4. Después revisa el estado: \`openfactura documento estado --token <token>\`. Recién emitido es normal ver
   \`Sin estado\` unos minutos. Puedes emitir con \`--esperar 120\` para que el CLI espere la respuesta.

Lo mismo vale para \`acusar\` y \`anular-guia\`: sin \`--confirmar\` sólo muestran lo que harían.

## Emitir

\`\`\`bash
# Factura (33). El receptor se completa con la ficha del SII. Precio unitario NETO
openfactura emitir factura --receptor 76.430.498-5 --item "Plan mensual|1|69000"

# Precio con IVA incluido: --con-iva lo desglosa
openfactura emitir factura --receptor 76430498-5 --item "Plan anual|1|177310" --con-iva

# Varias líneas y envío del documento por correo cuando el SII lo acepte
openfactura emitir factura --receptor 76430498-5 --item "Producto|2|10000" --item "Despacho|1|3000" --correo pagos@cliente.cl

# Factura que cita la guía de despacho y la orden de compra del cliente
openfactura emitir factura --receptor 76430498-5 --item "Producto|10|5000" --ref 52:123 --ref 801:OC-55:2026-09-01

# Boleta (39). Precio CON IVA. Sin --receptor va a consumidor final
openfactura emitir boleta --item "Producto|1|11900" --medio-pago transferencia

# Exentas: factura-exenta (34) y boleta-exenta (41), sólo para lo que la ley declara exento
openfactura emitir factura-exenta --receptor 76430498-5 --item "Arriendo oficina sin amoblar|1|500000"

# Guía de despacho (52). Desde el 1-nov-2026 exige chofer, transportista, patente y destino (Res. Ex. SII 154/2025)
openfactura emitir guia --receptor 76430498-5 --item "Caja|10|5000" --traslado venta --despacho emisor-cliente \\
  --destino-direccion "Calle 1" --destino-comuna Talca --chofer-rut 11111111-1 --chofer-nombre "Juan Pérez" \\
  --transportista-rut 76430498-5 --patente ABCD12

# Cualquier otro tipo (43, 46, exportación) o un DTE ya armado
openfactura emitir archivo dte.json
\`\`\`

Un ítem también puede ir como JSON, útil cuando el nombre trae \`|\` o hace falta una descripción:
\`--item '{"nombre":"Plan","cantidad":1,"precio":69000,"descripcion":"Septiembre 2026"}'\`.

Los precios van **sin separador de miles**: \`69000\`, no \`69.000\`. El CLI rechaza \`69.000\` porque es ambiguo.

**Exento no es "lo que no lleva IVA en mi cabeza".** Sólo es exento lo que la ley declara exento (DL 825
arts. 12 y 13). Un despacho, una asesoría o un curso de una empresa normalmente llevan IVA. Si dudas,
emítelo afecto y pregúntale al usuario o a su contador antes de marcar \`exento\`.

### ¿Factura o boleta?

- **Factura** cuando se le vende a otra empresa o persona con giro (vendedores o prestadores de servicios),
  la pida o no (DL 825 art. 53 letra a). También siempre en la venta de inmuebles.
- **Boleta** cuando el comprador es consumidor final. El CLI se niega a emitir factura a un RUT sin giro,
  y avisa si le emites boleta a un RUT con giro.
- Si no sabes, \`openfactura contribuyente <rut>\`: \`tieneGiro: false\` significa boleta.
- Una boleta sobre 135 UF exige RUT y nombre del comprador y el medio de pago (Res. Ex. SII 44/2025): usa
  \`--receptor\` y \`--medio-pago\`. Una boleta de servicio periódico (arriendo, suscripción) es nominativa:
  \`--ind-servicio 1\` o \`2\` con \`--receptor\`.

### Revisa el receptor antes de confirmar

La ficha del SII a veces trae la dirección repetida, un giro largo que se recorta a 40 caracteres, o un
giro distinto del que el cliente usa en sus facturas. Si el cliente ya tiene facturas anteriores, compara
con la última (\`openfactura documento json 33 <folio>\`) y corrige con \`--giro\`, \`--direccion\`,
\`--comuna\` o \`--razon-social\`.

## Notas de crédito y débito

Se amarran al documento original con \`--referencia <tipo>:<folio>\`. El CLI lee ese documento y toma de
ahí el receptor y la fecha, y valida la nota contra él.

\`\`\`bash
# Anular una factura completa: copia su detalle y sus montos
openfactura emitir nota-credito --referencia 33:30 --anula

# Rebajar parte del monto (descuento o devolución parcial) de una FACTURA. El ítem va en NETO
openfactura emitir nota-credito --referencia 33:30 --corrige-montos --razon "Descuento 50% primer mes" --item "Descuento|1|74500"

# Devolución parcial de una BOLETA. El ítem va CON IVA, como la boleta
openfactura emitir nota-credito --referencia 39:1004 --corrige-montos --razon "Devolución" --item "Devolución|1|11900"

# Corregir un dato sin tocar montos
openfactura emitir nota-credito --referencia 33:30 --corrige-texto --razon "Corrige giro del receptor"

# Nota de débito: cobrar algo que faltó
openfactura emitir nota-debito --referencia 33:30 --corrige-montos --razon "Intereses" --item "Intereses|1|5000"
\`\`\`

Reglas que el CLI hace cumplir, para que no te sorprendan:

- \`--anula\` deja sin efecto todo el documento y no acepta \`--item\`. Para una parte, \`--corrige-montos\`.
- La nota de crédito no puede rebajar más neto, exento, IVA ni total que el documento original. El CLI no
  suma otras notas ya emitidas contra el mismo documento: revisa \`openfactura emitidos --tipo 61\` antes.
- El receptor es siempre el del original. **Un RUT equivocado no se corrige con \`--corrige-texto\`**: se
  anula el documento con \`--anula\` y se emite uno nuevo al RUT correcto.
- No hay nota de débito sobre boleta: se emite una boleta nueva. Una nota de crédito se revierte con una
  nota de débito, no con otra nota de crédito.

Cuándo emitirla:

- **Devolución de plata o de mercadería**: cuando la plata se restituye de verdad. Si fue un reembolso
  con tarjeta, cuando la pasarela lo dé por cursado, no cuando se solicitó. Rebaja el IVA sólo si la
  devolución ocurre dentro de 6 meses desde la entrega (DL 825 art. 21 N° 2). Fuera de ese plazo, emítela
  con \`--sin-rebaja\`; el CLI avisa cuando el original tiene más de 6 meses.
- **Descuento posterior sin devolución**: cuando se otorga el descuento (art. 21 N° 1). No tiene el plazo
  de 6 meses.
- Si la factura ya fue cedida (factoring), anularla afecta al cesionario: avísale al usuario antes.

## Consultar

\`\`\`bash
openfactura documento estado 33 31            # ¿lo aceptó el SII?
openfactura documento pdf 33 31               # guarda el PDF (--salida para elegir el nombre)
openfactura documento xml 33 31
openfactura documento cedible 33 31           # copia cedible, para factoring
openfactura documento json 33 31              # el DTE tal como se emitió
openfactura documento estado 33 10 --rut 76430498-5   # un documento RECIBIDO: RUT de quien lo emitió

openfactura emitidos --desde 2026-09-01 --hasta 2026-09-30 --tipo 33
openfactura emitidos --tipo 33 --folio 31     # buscar un folio
openfactura emitidos --rut-receptor 76430498-5 --todas
openfactura recibidos --desde 2026-09-01 --todas

openfactura ventas 2026-09                    # resumen del mes por tipo de documento
openfactura compras 2026-09 --estado pendiente
openfactura contribuyente 76.430.498-5        # ficha SII de un RUT
openfactura folios                            # tipos de documento autorizados
\`\`\`

Para cuadrar un mes, compara \`openfactura ventas AAAA-MM\` con lo que dice tu propio sistema. Si
OpenFactura trae más documentos, alguien emitió por fuera.

## Errores que vas a ver

| Código | Qué significa | Qué hacer |
|---|---|---|
| \`yaEmitido: true\` | No es un error: ese mismo DTE ya se había enviado en las últimas 24 h y no se emitió otro. Trae el \`token\` si OpenFactura lo informó | Consulta el existente con ese token. **No** cambies \`--idempotency-key\` para forzar, salvo que el usuario quiera de verdad un segundo documento igual (dos ventas idénticas el mismo día) |
| \`OF-08\` | El DTE no cumple el esquema | No se consumió folio. Corrige y reintenta |
| \`OF-10\` | Validación de campos: montos que no cuadran, fecha, formato | El \`details\` dice qué campo |
| \`OF-22\` | No existe ese documento o folio | Revisa tipo, folio y RUT del emisor |
| \`AUTH\` | La API key es inválida o no está activa | Pide al usuario revisar su clave |
| \`RATE_LIMIT\` | OpenFactura siguió limitando después de 3 reintentos | Espera un minuto |
| \`OF-429\` | Límite propio de \`sincronizar-rcv\` | Espera los segundos de \`retry_after\` |
| \`VALIDATION\` | El CLI detectó un problema antes de enviar | Lee el mensaje: dice qué corregir |
| \`TIMEOUT\` al emitir | OpenFactura no respondió a tiempo, pero el documento pudo emitirse | Repite **exactamente** el mismo comando el mismo día: si ya se emitió, vuelve como \`yaEmitido\` |
| \`RESPUESTA_INVALIDA\` | OpenFactura respondió algo que no es una emisión | Igual que el timeout: repite el mismo comando |

## Lo que la API no permite

- Anular una factura o boleta: se anula con nota de crédito (\`--anula\`). Sólo la guía 52 se anula
  directo (\`anular-guia\`).
- Reenviar por correo un documento ya emitido: el envío sólo se pide al emitir (\`--correo\`). Después hay
  que bajar el PDF y mandarlo por otro medio.
- Webhooks, cesión de facturas, gestión de folios: no existen en la API.
`;

// src/commands/skill.ts
function carpetaSkills(env) {
  const casa = env.HOME || env.USERPROFILE || homedir();
  return join(casa, ".claude", "skills");
}
var SKILLS = [
  {
    nombre: "skill",
    resumen: "Imprime la skill para que Claude sepa usar este CLI",
    uso: "openfactura skill",
    sinClave: true,
    maxArgs: 0,
    run: ({ io }) => {
      io.out(SKILL_default);
      return;
    }
  },
  {
    nombre: "instalar-skill",
    resumen: "Instala la skill en Claude Code (~/.claude/skills/openfactura)",
    uso: [
      "openfactura instalar-skill [--destino <carpeta-de-skills>]",
      "",
      "Por defecto la deja en ~/.claude/skills/openfactura/SKILL.md, disponible en todos tus proyectos.",
      "Para un solo proyecto: --destino .claude/skills"
    ].join(`
`),
    sinClave: true,
    maxArgs: 0,
    flags: { destino: { type: "string" } },
    run: ({ flags, env }) => {
      const carpeta = join(texto(flags, "destino") ?? carpetaSkills(env), "openfactura");
      mkdirSync(carpeta, { recursive: true });
      const archivo = join(carpeta, "SKILL.md");
      writeFileSync3(archivo, SKILL_default);
      return { instalado: archivo, siguiente: "Reinicia Claude Code para que la cargue." };
    }
  }
];

// src/commands/index.ts
var COMANDOS = [...LECTURAS, ...EMISION, ...SKILLS];

// src/version.ts
var VERSION = "0.1.0";

// src/cli.ts
var FLAGS_GLOBALES = {
  "api-key": { type: "string" },
  dev: { type: "boolean" },
  timeout: { type: "string" },
  help: { type: "boolean", short: "h" }
};
function ayudaGeneral() {
  const ancho = Math.max(...COMANDOS.map((c) => c.nombre.length));
  const lineas = COMANDOS.map((c) => `  ${c.nombre.padEnd(ancho)}  ${c.resumen}`);
  return [
    `openfactura ${VERSION} · CLI para la API de OpenFactura (Haulmer)`,
    "",
    "Uso: openfactura <comando> [argumentos] [opciones]",
    "",
    "Comandos:",
    ...lineas,
    "",
    "Opciones globales:",
    "  --api-key <clave>  API key (o variable OPENFACTURA_API_KEY)",
    "  --dev              Usa el ambiente de pruebas dev-api.haulmer.com (o OPENFACTURA_ENV=dev)",
    "  --timeout <ms>     Tiempo máximo por llamada (default 60000)",
    "  -h, --help         Ayuda general o de un comando",
    "  --version          Versión",
    "",
    "La salida es JSON en stdout. Los errores salen como JSON en stderr, con código 1 si los",
    "rechazó OpenFactura y 2 si el problema está en los argumentos o la configuración."
  ].join(`
`);
}
function ayudaComando(c) {
  return [`openfactura ${c.nombre} · ${c.resumen}`, "", c.uso].join(`
`);
}
function buscarComando(posicionales) {
  const ordenados = [...COMANDOS].sort((a, b) => b.nombre.split(" ").length - a.nombre.split(" ").length);
  for (const c of ordenados) {
    const partes = c.nombre.split(" ");
    if (partes.every((p, i) => posicionales[i] === p))
      return { comando: c, resto: posicionales.slice(partes.length) };
  }
  return null;
}
function error(io, cuerpo, codigo) {
  io.err(JSON.stringify(cuerpo, null, 2));
  return codigo;
}
async function run(argv, env, io) {
  if (argv[0] === "--version") {
    io.out(VERSION);
    return 0;
  }
  const previos = [];
  let i = 0;
  while (i < argv.length && argv[i].startsWith("-")) {
    const a = argv[i];
    const nombre = a.replace(/^--?/, "").split("=")[0];
    const conValor = nombre === "api-key" || nombre === "timeout";
    if (!(nombre in FLAGS_GLOBALES) && nombre !== "h") {
      return error(io, { error: `Opción desconocida antes del comando: ${a}. Mira openfactura --help`, code: "USAGE" }, 2);
    }
    previos.push(a);
    if (conValor && !a.includes("=")) {
      const valor = argv[++i];
      const invalido = valor === undefined || valor.startsWith("-") || nombre === "timeout" && !/^\d+$/.test(valor);
      if (invalido)
        return error(io, { error: `${a} necesita un valor${nombre === "timeout" ? " en milisegundos" : ""}`, code: "USAGE" }, 2);
      previos.push(valor);
    }
    i++;
  }
  argv = argv.slice(i);
  if (argv.length === 0) {
    io.out(ayudaGeneral());
    return 0;
  }
  const inicial = argv.findIndex((a) => a.startsWith("-"));
  const cabeza = inicial === -1 ? argv : argv.slice(0, inicial);
  const encontrado = buscarComando(cabeza);
  if (!encontrado) {
    return error(io, { error: `Comando desconocido: ${cabeza.join(" ") || argv[0]}. Mira openfactura --help`, code: "USAGE" }, 2);
  }
  const { comando } = encontrado;
  const saltar = comando.nombre.split(" ").length;
  try {
    const { values, positionals } = parseArgs({
      args: [...argv.slice(saltar), ...previos],
      options: { ...FLAGS_GLOBALES, ...comando.flags ?? {} },
      allowPositionals: true,
      strict: true
    });
    if (values.help) {
      io.out(ayudaComando(comando));
      return 0;
    }
    const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2147483647)) {
      throw new UsageError("--timeout debe ser un número de milisegundos, de 1 a 2147483647");
    }
    let config = undefined;
    let client = undefined;
    if (!comando.sinClave) {
      config = resolveConfig({ apiKey: values["api-key"], dev: values.dev, timeoutMs: timeout }, env);
      client = new OpenFacturaClient(config);
    }
    if (comando.maxArgs !== undefined && positionals.length > comando.maxArgs) {
      throw new UsageError(`Sobran argumentos: ${positionals.slice(comando.maxArgs).join(" ")}. Mira openfactura ${comando.nombre} --help`);
    }
    const resultado = await comando.run({ client, config, flags: values, args: positionals, io, env });
    if (resultado !== undefined)
      io.out(JSON.stringify(resultado, null, 2));
    return 0;
  } catch (e) {
    if (e instanceof ApiError)
      return error(io, e.toJSON(), 1);
    if (e instanceof ValidationError)
      return error(io, { error: e.message, code: e.code, details: e.details }, 2);
    if (e instanceof UsageError || e instanceof ConfigError)
      return error(io, { error: e.message, code: e.code }, 2);
    const sistema = e;
    if (sistema.syscall) {
      return error(io, { error: `No se pudo ${sistema.syscall === "open" ? "escribir o leer" : sistema.syscall} ${sistema.path ?? "el archivo"}: ${sistema.code}`, code: "ARCHIVO" }, 2);
    }
    const nodeCode = sistema.code;
    if (typeof nodeCode === "string" && nodeCode.startsWith("ERR_PARSE_ARGS")) {
      return error(io, { error: e.message, code: "USAGE" }, 2);
    }
    return error(io, { error: String(e?.message ?? e), code: "INTERNAL" }, 1);
  }
}

// src/main.ts
var codigo = await run(process.argv.slice(2), process.env, {
  out: (s) => process.stdout.write(s + `
`),
  err: (s) => process.stderr.write(s + `
`)
});
process.exitCode = codigo;
