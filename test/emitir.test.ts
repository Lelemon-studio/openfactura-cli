import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";

type Llamada = { url: string; method: string; body: any; headers: Record<string, string> };
let llamadas: Llamada[] = [];
let rutas: Record<string, Array<{ status: number; body: unknown }>> = {};
const fetchOriginal = globalThis.fetch;
let dir = "";

const BASE = "https://api.haulmer.com/v2/dte";
const ORG = {
  rut: "76795561-8",
  razonSocial: "HAULMER CHILE SPA",
  direccion: "A PRAT   545 DP 2",
  comuna: "Curicó",
  cdgSIISucur: "81303347",
  glosaDescriptiva: "PRODUCTOS Y SERVICIOS DE INTERNET",
  actividades: [
    { giro: "X", codigoActividadEconomica: "474100", actividadPrincipal: false },
    { giro: "X", codigoActividadEconomica: "641990", actividadPrincipal: true },
  ],
};
const HOSTY = {
  rut: "76430498-5",
  razonSocial: "HOSTY SPA",
  direccion: "ARTURO PRAT 527",
  comuna: "Curicó",
  actividades: [
    { giro: "ACTIVIDADES DE CONSULTORIA DE INFORMATICA Y DE GESTION DE INSTALACIONES", codigoActividadEconomica: "620200", actividadPrincipal: true },
  ],
};
const SIN_GIRO = { rut: "11111111-1", razonSocial: "PERSONA NATURAL", direccion: "CALLE 1", comuna: "Santiago", actividades: [{ giro: null }] };

function responde(ruta: string, ...rs: Array<{ status: number; body: unknown }>) {
  rutas[ruta] = [...(rutas[ruta] ?? []), ...rs];
}

beforeEach(() => {
  llamadas = [];
  rutas = {};
  dir = mkdtempSync(join(tmpdir(), "of-"));
  responde("GET /organization", { status: 200, body: ORG });
  responde("GET /taxpayer/76430498-5", { status: 200, body: HOSTY });
  responde("GET /taxpayer/11111111-1", { status: 200, body: SIN_GIRO });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const ruta = String(url).replace(BASE, "");
    const metodo = init?.method ?? "GET";
    llamadas.push({
      url: ruta,
      method: metodo,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const cola = rutas[`${metodo} ${ruta}`];
    const r =
      cola && cola.length > 1 ? cola.shift()! : (cola?.[0] ?? { status: 404, body: { error: { message: `sin mock para ${metodo} ${ruta}`, code: "TEST" } } });
    return new Response(r.body == null ? null : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  rmSync(dir, { recursive: true, force: true });
});

async function ejecutar(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const codigo = await run(argv, { OPENFACTURA_API_KEY: "k", OPENFACTURA_LIMITE: "0" }, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { codigo, out: out.length ? JSON.parse(out.join("")) : undefined, err: err.length ? JSON.parse(err.join("")) : undefined };
}

const emisiones = () => llamadas.filter((l) => l.method === "POST" && l.url === "/document");
const FECHA = ["--fecha", "2026-09-27"];

describe("factura", () => {
  test("sin --confirmar arma el DTE completo y no emite", async () => {
    const r = await ejecutar("emitir", "factura", "--receptor", "76.430.498-5", "--item", "Plan mensual|1|69000", ...FECHA);
    expect(r.codigo).toBe(0);
    expect(emisiones()).toHaveLength(0);
    expect(r.out.enSeco).toBe(true);
    expect(r.out.dte).toEqual({
      Encabezado: {
        IdDoc: { TipoDTE: 33, Folio: 0, FchEmis: "2026-09-27" },
        Emisor: {
          RUTEmisor: "76795561-8",
          RznSoc: "HAULMER CHILE SPA",
          GiroEmis: "PRODUCTOS Y SERVICIOS DE INTERNET",
          Acteco: 641990,
          DirOrigen: "A PRAT 545 DP 2",
          CmnaOrigen: "Curicó",
          CdgSIISucur: "81303347",
        },
        Receptor: {
          RUTRecep: "76430498-5",
          RznSocRecep: "HOSTY SPA",
          GiroRecep: "ACTIVIDADES DE CONSULTORIA DE INFORMATIC",
          DirRecep: "ARTURO PRAT 527",
          CmnaRecep: "Curicó",
        },
        Totales: { MntNeto: 69000, TasaIVA: 19, IVA: 13110, MntTotal: 82110 },
      },
      Detalle: [{ NroLinDet: 1, NmbItem: "Plan mensual", QtyItem: 1, PrcItem: 69000, MontoItem: 69000 }],
    });
    expect(r.out.resumen).toMatchObject({ tipo: 33, receptor: "HOSTY SPA", neto: 69000, iva: 13110, total: 82110 });
  });

  test("avisa que el giro del receptor se recortó a 40", async () => {
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "x|1|1000", ...FECHA);
    expect(r.out.avisos.join(" ")).toContain("40");
  });

  test("con --confirmar emite con Idempotency-Key y devuelve folio y token", async () => {
    responde("POST /document", { status: 200, body: { TOKEN: "tok123", FOLIO: 31 } });
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "Plan|1|69000", ...FECHA, "--confirmar");
    expect(r.codigo).toBe(0);
    const e = emisiones()[0]!;
    expect(e.body.response).toEqual(["FOLIO"]);
    expect(e.body.dte.Encabezado.IdDoc.TipoDTE).toBe(33);
    expect(e.headers["Idempotency-Key"]).toMatch(/^[a-f0-9]{64}$/);
    expect(r.out).toMatchObject({ emitido: true, tipo: 33, folio: 31, token: "tok123", total: 82110 });
  });

  test("la misma emisión repetida lleva la misma Idempotency-Key", async () => {
    responde("POST /document", { status: 200, body: { TOKEN: "t", FOLIO: 1 } });
    await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "Plan|1|69000", ...FECHA, "--confirmar");
    await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "Plan|1|69000", ...FECHA, "--confirmar");
    const [a, b] = emisiones();
    expect(a!.headers["Idempotency-Key"]).toBe(b!.headers["Idempotency-Key"]!);
  });

  test("otra fecha cambia la Idempotency-Key", async () => {
    const a = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "Plan|1|69000", "--fecha", "2026-09-27");
    const b = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "Plan|1|69000", "--fecha", "2026-10-27");
    expect(a.out.idempotencyKey).not.toBe(b.out.idempotencyKey);
  });

  test("a un RUT sin giro no se le emite factura y se sugiere boleta", async () => {
    const r = await ejecutar("emitir", "factura", "--receptor", "11111111-1", "--item", "x|1|1000", ...FECHA);
    expect(r.codigo).toBe(2);
    expect(r.err.code).toBe("VALIDATION");
    expect(r.err.error).toContain("boleta");
  });

  test("los datos del receptor se pueden reemplazar a mano", async () => {
    const r = await ejecutar(
      "emitir",
      "factura",
      "--receptor",
      "76430498-5",
      "--giro",
      "SERVICIOS",
      "--direccion",
      "OTRA 1",
      "--comuna",
      "Talca",
      "--item",
      "x|1|1000",
      ...FECHA,
    );
    expect(r.out.dte.Encabezado.Receptor).toMatchObject({ GiroRecep: "SERVICIOS", DirRecep: "OTRA 1", CmnaRecep: "Talca" });
  });

  test("--correo agrega CorreoRecep y el envío por correo tras la aceptación", async () => {
    responde("POST /document", { status: 200, body: { TOKEN: "t", FOLIO: 2 } });
    await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "x|1|1000", "--correo", "pagos@hosty.cl", ...FECHA, "--confirmar");
    const e = emisiones()[0]!;
    expect(e.body.dte.Encabezado.Receptor.CorreoRecep).toBe("pagos@hosty.cl");
    expect(e.body.sendEmail).toEqual({ to: "pagos@hosty.cl" });
  });

  test("un correo mal escrito falla", async () => {
    expect((await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "x|1|1000", "--correo", "pagos-hosty.cl", ...FECHA)).codigo).toBe(2);
  });

  test("--con-iva desglosa el precio bruto", async () => {
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "Plan|1|177310", "--con-iva", ...FECHA);
    expect(r.out.dte.Encabezado.Totales).toEqual({ MntNeto: 149000, TasaIVA: 19, IVA: 28310, MntTotal: 177310 });
  });

  test("el ítem acepta JSON con descripción y exento", async () => {
    const r = await ejecutar(
      "emitir",
      "factura",
      "--receptor",
      "76430498-5",
      "--item",
      '{"nombre":"Envío","cantidad":2,"precio":500,"exento":true,"descripcion":"Despacho"}',
      "--item",
      "Producto|1|1000",
      ...FECHA,
    );
    expect(r.out.dte.Detalle[0]).toEqual({ NroLinDet: 1, NmbItem: "Envío", DscItem: "Despacho", QtyItem: 2, PrcItem: 500, MontoItem: 1000, IndExe: 1 });
    expect(r.out.dte.Encabezado.Totales).toEqual({ MntNeto: 1000, MntExe: 1000, TasaIVA: 19, IVA: 190, MntTotal: 2190 });
  });

  test("el guion largo del nombre se cambia por uno corto y se avisa", async () => {
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "Plan — mensual|1|1000", ...FECHA);
    expect(r.out.dte.Detalle[0].NmbItem).toBe("Plan - mensual");
    expect(r.out.avisos.join(" ")).toContain("guion");
  });

  test("un nombre de más de 80 caracteres falla", async () => {
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", `${"a".repeat(81)}|1|1000`, ...FECHA);
    expect(r.codigo).toBe(2);
  });

  test("un ítem mal escrito falla con un mensaje que explica el formato", async () => {
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "Plan 69000", ...FECHA);
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("nombre|cantidad|precio");
  });

  test("--forma-pago contado agrega FmaPago 1", async () => {
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "x|1|1000", "--forma-pago", "contado", ...FECHA);
    expect(r.out.dte.Encabezado.IdDoc.FmaPago).toBe(1);
  });

  test("--pdf pide el PDF y lo guarda al emitir", async () => {
    responde("POST /document", { status: 200, body: { TOKEN: "t", FOLIO: 9, PDF: Buffer.from("%PDF-1").toString("base64") } });
    const archivo = join(dir, "f.pdf");
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "x|1|1000", ...FECHA, "--pdf", archivo, "--confirmar");
    expect(emisiones()[0]!.body.response).toEqual(["FOLIO", "PDF"]);
    expect(r.out.pdf).toEqual({ archivo, bytes: 6 });
  });

  test("--esperar consulta el estado hasta que el SII responde", async () => {
    responde("POST /document", { status: 200, body: { TOKEN: "tok", FOLIO: 5 } });
    responde("GET /document/tok/status", { status: 200, body: { estado: "Sin estado" } }, { status: 200, body: { estado: "Aceptado" } });
    const r = await ejecutar(
      "emitir",
      "factura",
      "--receptor",
      "76430498-5",
      "--item",
      "x|1|1000",
      ...FECHA,
      "--confirmar",
      "--esperar",
      "5",
      "--intervalo",
      "1",
    );
    expect(r.out.estado).toBe("Aceptado");
  });

  test("un rechazo de OpenFactura sale con código 1 y el detalle", async () => {
    responde("POST /document", { status: 400, body: { error: { message: "Error de esquema", code: "OF-08", details: [{ field: "IdDoc" }] } } });
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "x|1|1000", ...FECHA, "--confirmar");
    expect(r.codigo).toBe(1);
    expect(r.err.code).toBe("OF-08");
  });
});

describe("boleta", () => {
  test("sin receptor va a consumidor final con el esquema de boleta", async () => {
    const r = await ejecutar("emitir", "boleta", "--item", "Plan|1|48732", ...FECHA);
    expect(r.out.dte).toEqual({
      Encabezado: {
        IdDoc: { TipoDTE: 39, Folio: 0, FchEmis: "2026-09-27", IndServicio: 3 },
        Emisor: {
          RUTEmisor: "76795561-8",
          RznSocEmisor: "HAULMER CHILE SPA",
          GiroEmisor: "PRODUCTOS Y SERVICIOS DE INTERNET",
          DirOrigen: "A PRAT 545 DP 2",
          CmnaOrigen: "Curicó",
          CdgSIISucur: "81303347",
        },
        Receptor: { RUTRecep: "66666666-6", RznSocRecep: "Cliente", DirRecep: "Sin direccion", CmnaRecep: "Santiago" },
        Totales: { MntNeto: 40951, IVA: 7781, MntTotal: 48732 },
      },
      Detalle: [{ NroLinDet: 1, NmbItem: "Plan", QtyItem: 1, PrcItem: 48732, MontoItem: 48732 }],
    });
  });

  test("con receptor usa su nombre pero no le pone giro", async () => {
    const r = await ejecutar("emitir", "boleta", "--receptor", "11111111-1", "--item", "x|1|1190", ...FECHA);
    expect(r.out.dte.Encabezado.Receptor).toEqual({ RUTRecep: "11111111-1", RznSocRecep: "PERSONA NATURAL", DirRecep: "CALLE 1", CmnaRecep: "Santiago" });
  });

  test("boleta exenta lleva sólo MntExe y líneas exentas", async () => {
    const r = await ejecutar("emitir", "boleta-exenta", "--item", "Curso|1|5000", ...FECHA);
    expect(r.out.dte.Encabezado.IdDoc.TipoDTE).toBe(41);
    expect(r.out.dte.Encabezado.Totales).toEqual({ MntExe: 5000, MntTotal: 5000 });
    expect(r.out.dte.Detalle[0].IndExe).toBe(1);
  });

  test("--medio-pago agrega MedioPago de boleta", async () => {
    const r = await ejecutar("emitir", "boleta", "--item", "x|1|1190", "--medio-pago", "transferencia", ...FECHA);
    expect(r.out.dte.Encabezado.IdDoc.MedioPago).toBe(3);
  });
});

describe("factura exenta", () => {
  test("lleva TipoDTE 34, sin IVA y con líneas exentas", async () => {
    const r = await ejecutar("emitir", "factura-exenta", "--receptor", "76430498-5", "--item", "Asesoría|1|100000", ...FECHA);
    expect(r.out.dte.Encabezado.IdDoc.TipoDTE).toBe(34);
    expect(r.out.dte.Encabezado.Totales).toEqual({ MntExe: 100000, MntTotal: 100000 });
    expect(r.out.dte.Detalle[0].IndExe).toBe(1);
  });
});

const FACTURA_30 = {
  json: {
    Encabezado: {
      IdDoc: { TipoDTE: 33, Folio: 30, FchEmis: "2026-09-22" },
      Receptor: { RUTRecep: "76430498-5", RznSocRecep: "HOSTY SPA", GiroRecep: "SERVICIOS", DirRecep: "MONTT 152", CmnaRecep: "Curicó" },
      Totales: { MntNeto: 149000, TasaIVA: 19, IVA: 28310, MntTotal: 177310 },
    },
    Detalle: [{ NroLinDet: 1, NmbItem: "Plan Estudio", QtyItem: 1, PrcItem: 149000, MontoItem: 149000 }],
  },
};

describe("nota de crédito", () => {
  beforeEach(() => responde("GET /document/76795561-8/33/30/json", { status: 200, body: FACTURA_30 }));

  test("corrige montos: toma receptor y fecha del documento original", async () => {
    const r = await ejecutar(
      "emitir",
      "nota-credito",
      "--referencia",
      "33:30",
      "--corrige-montos",
      "--razon",
      "Descuento 50%",
      "--item",
      "Descuento|1|74500",
      ...FECHA,
    );
    expect(r.codigo).toBe(0);
    expect(r.out.dte.Encabezado.IdDoc.TipoDTE).toBe(61);
    expect(r.out.dte.Encabezado.Receptor).toEqual(FACTURA_30.json.Encabezado.Receptor);
    expect(r.out.dte.Encabezado.Totales).toEqual({ MntNeto: 74500, TasaIVA: 19, IVA: 14155, MntTotal: 88655 });
    expect(r.out.dte.Referencia).toEqual([{ NroLinRef: 1, TpoDocRef: "33", FolioRef: 30, FchRef: "2026-09-22", CodRef: 3, RazonRef: "Descuento 50%" }]);
  });

  test("anula: copia el detalle completo del original", async () => {
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "33:30", "--anula", ...FECHA);
    expect(r.out.dte.Detalle).toEqual(FACTURA_30.json.Detalle);
    expect(r.out.dte.Encabezado.Totales).toEqual(FACTURA_30.json.Encabezado.Totales);
    expect(r.out.dte.Referencia[0]).toMatchObject({ CodRef: 1, RazonRef: "Anula documento" });
  });

  test("una nota de crédito que supera al original falla", async () => {
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "33:30", "--corrige-montos", "--item", "x|1|200000", ...FECHA);
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("supera");
  });

  test("corrige texto: montos en cero y la corrección en el detalle", async () => {
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "33:30", "--corrige-texto", "--razon", "Corrige giro del receptor", ...FECHA);
    expect(r.out.dte.Detalle).toEqual([{ NroLinDet: 1, NmbItem: "Corrige giro del receptor", QtyItem: 1, MontoItem: 0 }]);
    expect(r.out.dte.Encabezado.Totales).toEqual({ MntNeto: 0, TasaIVA: 19, IVA: 0, MntTotal: 0 });
    expect(r.out.dte.Referencia[0].CodRef).toBe(2);
  });

  test("sin --referencia falla", async () => {
    expect((await ejecutar("emitir", "nota-credito", "--corrige-montos", "--item", "x|1|1", ...FECHA)).codigo).toBe(2);
  });

  test("sin decir qué hace (anula, corrige montos o texto) falla", async () => {
    expect((await ejecutar("emitir", "nota-credito", "--referencia", "33:30", "--item", "x|1|1", ...FECHA)).codigo).toBe(2);
  });

  test("siempre lee el original, aunque se dé el receptor, para validar contra él", async () => {
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "33:30", "--receptor", "76430498-5", "--corrige-montos", "--item", "x|1|1000", ...FECHA);
    expect(llamadas.some((l) => l.url.endsWith("/33/30/json"))).toBe(true);
    expect(r.out.dte.Referencia[0].FchRef).toBe("2026-09-22");
  });

  test("nota de crédito sobre boleta referencia la 39 y toma el receptor de la boleta", async () => {
    responde("GET /document/76795561-8/39/1004/json", {
      status: 200,
      body: {
        json: {
          Encabezado: {
            IdDoc: { TipoDTE: 39, FchEmis: "2026-09-17" },
            Receptor: { RUTRecep: "66666666-6", RznSocRecep: "Cliente" },
            Totales: { MntNeto: 40951, IVA: 7781, MntTotal: 48732 },
          },
          Detalle: [],
        },
      },
    });
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "39:1004", "--corrige-montos", "--item", "Devolución|1|10000", ...FECHA);
    expect(r.out.dte.Referencia[0]).toMatchObject({ TpoDocRef: "39", FolioRef: 1004 });
  });
});

describe("nota de débito", () => {
  test("lleva TipoDTE 56 y referencia", async () => {
    responde("GET /document/76795561-8/33/30/json", { status: 200, body: FACTURA_30 });
    const r = await ejecutar(
      "emitir",
      "nota-debito",
      "--referencia",
      "33:30",
      "--corrige-montos",
      "--razon",
      "Intereses",
      "--item",
      "Intereses|1|5000",
      ...FECHA,
    );
    expect(r.out.dte.Encabezado.IdDoc.TipoDTE).toBe(56);
    expect(r.out.dte.Referencia[0].CodRef).toBe(3);
  });
});

describe("guía de despacho", () => {
  test("exige el motivo del traslado", async () => {
    expect((await ejecutar("emitir", "guia", "--receptor", "76430498-5", "--item", "Caja|10|1000", ...FECHA)).codigo).toBe(2);
  });

  test("lleva IndTraslado, despacho y destino", async () => {
    const r = await ejecutar(
      "emitir",
      "guia",
      "--receptor",
      "76430498-5",
      "--item",
      "Caja|10|1000",
      "--traslado",
      "venta",
      "--despacho",
      "emisor-cliente",
      "--destino-direccion",
      "Calle 2",
      "--destino-comuna",
      "Talca",
      ...FECHA,
    );
    expect(r.out.dte.Encabezado.IdDoc).toMatchObject({ TipoDTE: 52, IndTraslado: 1, TipoDespacho: 2 });
    expect(r.out.dte.Encabezado.Transporte).toEqual({ DirDest: "Calle 2", CmnaDest: "Talca" });
    expect(r.out.dte.Encabezado.Totales.MntTotal).toBe(11900);
  });

  test("un traslado interno puede ir en cero", async () => {
    const r = await ejecutar("emitir", "guia", "--receptor", "76430498-5", "--item", "Caja|10|0", "--traslado", "interno", ...FECHA);
    expect(r.codigo).toBe(0);
    expect(r.out.dte.Encabezado.IdDoc.IndTraslado).toBe(5);
  });
});

describe("desde archivo", () => {
  test("manda el DTE del archivo tal cual, en seco por defecto", async () => {
    const archivo = join(dir, "dte.json");
    const dte = { Encabezado: { IdDoc: { TipoDTE: 46, Folio: 0, FchEmis: "2026-09-27" }, Totales: { MntTotal: 1 } }, Detalle: [{ NroLinDet: 1 }] };
    writeFileSync(archivo, JSON.stringify(dte));
    const r = await ejecutar("emitir", "archivo", archivo);
    expect(r.out.enSeco).toBe(true);
    expect(r.out.dte).toEqual(dte);
    expect(emisiones()).toHaveLength(0);
  });

  test("acepta el body completo con dte y response", async () => {
    responde("POST /document", { status: 200, body: { TOKEN: "t", FOLIO: 3 } });
    const archivo = join(dir, "body.json");
    writeFileSync(archivo, JSON.stringify({ response: ["FOLIO", "TIMBRE"], dte: { Encabezado: { IdDoc: { TipoDTE: 33, Folio: 0 } }, Detalle: [] } }));
    await ejecutar("emitir", "archivo", archivo, "--confirmar");
    expect(emisiones()[0]!.body.response).toEqual(["FOLIO", "TIMBRE"]);
  });

  test("un Folio distinto de 0 falla, porque OpenFactura asigna el folio", async () => {
    const archivo = join(dir, "dte.json");
    writeFileSync(archivo, JSON.stringify({ Encabezado: { IdDoc: { TipoDTE: 33, Folio: 12 } }, Detalle: [] }));
    expect((await ejecutar("emitir", "archivo", archivo)).codigo).toBe(2);
  });

  test("un archivo que no es JSON falla", async () => {
    const archivo = join(dir, "dte.json");
    writeFileSync(archivo, "no es json");
    expect((await ejecutar("emitir", "archivo", archivo)).codigo).toBe(2);
  });
});

describe("tipos", () => {
  test("un tipo desconocido falla y lista los que existen", async () => {
    const r = await ejecutar("emitir", "cheque", "--item", "x|1|1");
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("factura");
  });
});
