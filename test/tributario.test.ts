import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { run } from "../src/cli.ts";

type Llamada = { url: string; method: string; body: any };
let llamadas: Llamada[] = [];
let rutas: Record<string, Array<{ status: number; body: unknown }>> = {};
const fetchOriginal = globalThis.fetch;
const BASE = "https://api.haulmer.com/v2/dte";

const ORG = {
  rut: "76795561-8",
  razonSocial: "HAULMER CHILE SPA",
  direccion: "A PRAT 545",
  comuna: "Curicó",
  glosaDescriptiva: "SERVICIOS",
  actividades: [{ giro: "X", codigoActividadEconomica: "641990", actividadPrincipal: true }],
};
const HOSTY = { rut: "76430498-5", razonSocial: "HOSTY SPA", direccion: "PRAT 527", comuna: "Curicó", actividades: [{ giro: "CONSULTORIA", codigoActividadEconomica: "620200", actividadPrincipal: true }] };
const OTRO = { rut: "11111111-1", razonSocial: "OTRA SPA", direccion: "X 1", comuna: "Talca", actividades: [{ giro: "COMERCIO", codigoActividadEconomica: "1", actividadPrincipal: true }] };
const RECEPTOR_30 = { RUTRecep: "76430498-5", RznSocRecep: "HOSTY SPA", GiroRecep: "SERVICIOS", DirRecep: "MONTT 152", CmnaRecep: "Curicó" };

function doc(tipo: number, fecha: string, receptor: object, totales: object, detalle: object[]) {
  return { status: 200, body: { json: { Encabezado: { IdDoc: { TipoDTE: tipo, FchEmis: fecha }, Receptor: receptor, Totales: totales }, Detalle: detalle } } };
}

function responde(ruta: string, ...rs: Array<{ status: number; body: unknown }>) {
  (rutas[ruta] ??= []).push(...rs);
}

beforeEach(() => {
  llamadas = [];
  rutas = {};
  responde("GET /organization", { status: 200, body: ORG });
  responde("GET /taxpayer/76430498-5", { status: 200, body: HOSTY });
  responde("GET /taxpayer/11111111-1", { status: 200, body: OTRO });
  responde("GET /document/76795561-8/33/30/json", doc(33, "2026-09-22", RECEPTOR_30, { MntNeto: 149000, TasaIVA: 19, IVA: 28310, MntTotal: 177310 }, [{ NroLinDet: 1, NmbItem: "Plan", QtyItem: 1, PrcItem: 149000, MontoItem: 149000 }]));
  responde("GET /document/76795561-8/33/40/json", doc(33, "2026-09-01", RECEPTOR_30, { MntNeto: 1000, MntExe: 50000, TasaIVA: 19, IVA: 190, MntTotal: 51190 }, [{ NroLinDet: 1, NmbItem: "A", QtyItem: 1, PrcItem: 1000, MontoItem: 1000 }, { NroLinDet: 2, NmbItem: "B", QtyItem: 1, PrcItem: 50000, MontoItem: 50000, IndExe: 1 }]));
  responde("GET /document/76795561-8/33/10/json", doc(33, "2026-01-15", RECEPTOR_30, { MntNeto: 10000, TasaIVA: 19, IVA: 1900, MntTotal: 11900 }, [{ NroLinDet: 1, NmbItem: "Viejo", QtyItem: 1, PrcItem: 10000, MontoItem: 10000 }]));
  responde("GET /document/76795561-8/39/1004/json", doc(39, "2026-09-17", { RUTRecep: "66666666-6", RznSocRecep: "Cliente", DirRecep: "Sin direccion", CmnaRecep: "Santiago" }, { MntNeto: 40951, IVA: 7781, MntTotal: 48732 }, [{ NroLinDet: 1, NmbItem: "Plan", QtyItem: 1, PrcItem: 48732, MontoItem: 48732 }]));
  responde("GET /document/76795561-8/34/5/json", doc(34, "2026-09-10", RECEPTOR_30, { MntExe: 100000, MntTotal: 100000 }, [{ NroLinDet: 1, NmbItem: "Arriendo", QtyItem: 1, PrcItem: 100000, MontoItem: 100000, IndExe: 1 }]));
  responde("GET /document/76795561-8/52/123/json", doc(52, "2026-09-20", RECEPTOR_30, { MntNeto: 10000, TasaIVA: 19, IVA: 1900, MntTotal: 11900 }, []));
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const ruta = String(url).replace(BASE, "");
    const metodo = init?.method ?? "GET";
    llamadas.push({ url: ruta, method: metodo, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const cola = rutas[`${metodo} ${ruta}`];
    const r = cola?.[0] ?? { status: 404, body: { error: { message: `sin mock ${metodo} ${ruta}`, code: "TEST" } } };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

async function ejecutar(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const codigo = await run(argv, { OPENFACTURA_API_KEY: "k", OPENFACTURA_LIMITE: "0" }, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { codigo, out: out.length ? JSON.parse(out.join("")) : undefined, err: err.length ? JSON.parse(err.join("")) : undefined };
}

const HOY = ["--fecha", "2026-09-27"];
const NC = (...a: string[]) => ejecutar("emitir", "nota-credito", ...a, ...HOY);

describe("nota de crédito sobre boleta: montos brutos", () => {
  test("el ítem va con IVA incluido y se marca MntBruto", async () => {
    const r = await NC("--referencia", "39:1004", "--corrige-montos", "--item", "Devolución|1|11900");
    expect(r.codigo).toBe(0);
    expect(r.out.dte.Encabezado.IdDoc.MntBruto).toBe(1);
    expect(r.out.dte.Detalle[0]).toMatchObject({ PrcItem: 11900, MontoItem: 11900 });
    expect(r.out.dte.Encabezado.Totales).toEqual({ MntNeto: 10000, TasaIVA: 19, IVA: 1900, MntTotal: 11900 });
  });

  test("anular una boleta da el mismo total que la boleta", async () => {
    const r = await NC("--referencia", "39:1004", "--anula");
    expect(r.out.dte.Encabezado.IdDoc.MntBruto).toBe(1);
    expect(r.out.dte.Encabezado.Totales).toEqual({ MntNeto: 40951, TasaIVA: 19, IVA: 7781, MntTotal: 48732 });
  });

  test("una devolución mayor que la boleta se rechaza", async () => {
    expect((await NC("--referencia", "39:1004", "--corrige-montos", "--item", "x|1|50000")).codigo).toBe(2);
  });

  test("no se emite nota de débito sobre una boleta", async () => {
    const r = await ejecutar("emitir", "nota-debito", "--referencia", "39:1004", "--corrige-montos", "--item", "x|1|100", ...HOY);
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("boleta");
  });
});

describe("anular es anular todo", () => {
  test("--anula no acepta ítems", async () => {
    expect((await NC("--referencia", "33:30", "--anula", "--item", "x|1|100")).codigo).toBe(2);
  });
});

describe("tope de la nota de crédito por componente", () => {
  test("rebajar más IVA del facturado se rechaza aunque el total no supere", async () => {
    const r = await NC("--referencia", "33:40", "--corrige-montos", "--item", "Descuento|1|40000");
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("IVA");
  });

  test("una rebaja exenta dentro de lo facturado pasa", async () => {
    expect((await NC("--referencia", "33:40", "--corrige-montos", "--item", "Descuento|1|20000|exento")).codigo).toBe(0);
  });

  test("avisa que no suma otras notas ya emitidas contra el mismo documento", async () => {
    const r = await NC("--referencia", "33:30", "--corrige-montos", "--item", "x|1|1000");
    expect(r.out.avisos.join(" ")).toContain("otras notas");
  });
});

describe("receptor de la nota = receptor del original", () => {
  test("otro RUT se rechaza", async () => {
    const r = await NC("--referencia", "33:30", "--receptor", "11111111-1", "--corrige-montos", "--item", "x|1|1000");
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("receptor");
  });

  test("el mismo RUT permite corregir giro o dirección", async () => {
    const r = await NC("--referencia", "33:30", "--receptor", "76430498-5", "--giro", "NUEVO GIRO", "--corrige-montos", "--item", "x|1|1000");
    expect(r.codigo).toBe(0);
    expect(r.out.dte.Encabezado.Receptor.GiroRecep).toBe("NUEVO GIRO");
  });
});

describe("documentos que se pueden referenciar", () => {
  test("nota de crédito sobre una guía se rechaza", async () => {
    expect((await NC("--referencia", "52:123", "--corrige-montos", "--item", "x|1|100")).codigo).toBe(2);
  });

  test("nota de crédito sobre otra nota de crédito se rechaza", async () => {
    const r = await NC("--referencia", "61:1", "--corrige-montos", "--item", "x|1|100");
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("nota de débito");
  });
});

describe("plazos", () => {
  test("la nota no puede tener fecha anterior al documento que corrige", async () => {
    expect((await ejecutar("emitir", "nota-credito", "--referencia", "33:30", "--corrige-montos", "--item", "x|1|100", "--fecha", "2026-09-01")).codigo).toBe(2);
  });

  test("sobre un documento de hace más de 6 meses avisa por el plazo de rebaja del IVA", async () => {
    const r = await NC("--referencia", "33:10", "--corrige-montos", "--item", "x|1|100");
    expect(r.out.avisos.join(" ")).toContain("6 meses");
  });

  test("--sin-rebaja marca IndNoRebaja", async () => {
    const r = await NC("--referencia", "33:10", "--corrige-montos", "--item", "x|1|100", "--sin-rebaja");
    expect(r.out.dte.Encabezado.IdDoc.IndNoRebaja).toBe(1);
  });
});

describe("corregir texto de un documento exento", () => {
  test("va sólo con MntExe y la línea exenta", async () => {
    const r = await NC("--referencia", "34:5", "--corrige-texto", "--razon", "Corrige dirección");
    expect(r.out.dte.Encabezado.Totales).toEqual({ MntExe: 0, MntTotal: 0 });
    expect(r.out.dte.Detalle[0].IndExe).toBe(1);
  });

  test("una razón de más de 80 caracteres se rechaza en vez de cortarse", async () => {
    expect((await NC("--referencia", "33:30", "--corrige-texto", "--razon", "x".repeat(81))).codigo).toBe(2);
  });
});

describe("guía de despacho y Res. 154/2025", () => {
  const GUIA = ["emitir", "guia", "--receptor", "76430498-5", "--item", "Caja|1|1000", "--traslado", "venta", "--destino-direccion", "Calle 2", "--destino-comuna", "Talca"];

  test("desde el 1-nov-2026 exige chofer y patente", async () => {
    const r = await ejecutar(...GUIA, "--fecha", "2026-11-02");
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("154");
  });

  test("con chofer, transportista y patente arma el Transporte", async () => {
    const r = await ejecutar(...GUIA, "--fecha", "2026-11-02", "--chofer-rut", "11111111-1", "--chofer-nombre", "Juan Pérez", "--transportista-rut", "76430498-5", "--patente", "ABCD12");
    expect(r.codigo).toBe(0);
    expect(r.out.dte.Encabezado.Transporte).toEqual({
      Patente: "ABCD12",
      RUTTrans: "76430498-5",
      Chofer: { RUTChofer: "11111111-1", NombreChofer: "Juan Pérez" },
      DirDest: "Calle 2",
      CmnaDest: "Talca",
    });
  });

  test("antes del 1-nov-2026 sólo avisa", async () => {
    const r = await ejecutar(...GUIA, ...HOY);
    expect(r.codigo).toBe(0);
    expect(r.out.avisos.join(" ")).toContain("154");
  });

  test("una guía de venta en cero avisa", async () => {
    const r = await ejecutar("emitir", "guia", "--receptor", "76430498-5", "--item", "Caja|1|0", "--traslado", "venta", ...HOY);
    expect(r.out.avisos.join(" ")).toContain("cero");
  });
});

describe("factura que referencia guías u órdenes de compra", () => {
  test("--ref a una guía propia toma su fecha", async () => {
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "Caja|1|10000", "--ref", "52:123", ...HOY);
    expect(r.out.dte.Referencia).toEqual([{ NroLinRef: 1, TpoDocRef: "52", FolioRef: 123, FchRef: "2026-09-20" }]);
  });

  test("--ref a una orden de compra exige la fecha y admite folio con letras", async () => {
    expect((await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "x|1|100", "--ref", "801:OC-55", ...HOY)).codigo).toBe(2);
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "x|1|100", "--ref", "801:OC-55:2026-09-01", ...HOY);
    expect(r.out.dte.Referencia[0]).toEqual({ NroLinRef: 1, TpoDocRef: "801", FolioRef: "OC-55", FchRef: "2026-09-01" });
  });
});

describe("tipo de documento según las líneas", () => {
  test("una factura con todas las líneas exentas se rechaza y sugiere factura-exenta", async () => {
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "Arriendo|1|100000|exento", ...HOY);
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("factura-exenta");
  });

  test("una boleta con todas las líneas exentas sugiere boleta-exenta", async () => {
    const r = await ejecutar("emitir", "boleta", "--item", "x|1|1000|exento", ...HOY);
    expect(r.err.error).toContain("boleta-exenta");
  });
});

describe("boletas que exigen identificar al comprador", () => {
  test("una boleta grande sin receptor ni medio de pago se rechaza", async () => {
    const r = await ejecutar("emitir", "boleta", "--item", "Auto|1|6000000", ...HOY);
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("135 UF");
  });

  test("una boleta de servicio periódico exige receptor", async () => {
    expect((await ejecutar("emitir", "boleta", "--item", "Plan|1|10000", "--ind-servicio", "1", ...HOY)).codigo).toBe(2);
  });

  test("una boleta a un RUT con giro avisa que corresponde factura", async () => {
    const r = await ejecutar("emitir", "boleta", "--receptor", "76430498-5", "--item", "x|1|1190", ...HOY);
    expect(r.out.avisos.join(" ")).toContain("factura");
  });
});

describe("fecha", () => {
  test("una fecha futura avisa", async () => {
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "x|1|100", "--fecha", "2099-01-01");
    expect(r.out.avisos.join(" ")).toContain("futura");
  });
});
