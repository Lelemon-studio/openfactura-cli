import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";

type Llamada = { url: string; method: string; body: unknown };
let llamadas: Llamada[] = [];
let respuestas: Array<{ status: number; body: unknown }> = [];
const fetchOriginal = globalThis.fetch;
let dir = "";

beforeEach(() => {
  llamadas = [];
  respuestas = [];
  dir = mkdtempSync(join(tmpdir(), "of-"));
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = respuestas.shift() ?? { status: 200, body: {} };
    return new Response(r.body == null ? null : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  rmSync(dir, { recursive: true, force: true });
});

const BASE = "https://api.haulmer.com/v2/dte";
const ENV = { OPENFACTURA_API_KEY: "k" };

async function ejecutar(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const codigo = await run(argv, ENV, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { codigo, out: out.length ? JSON.parse(out.join("")) : undefined, err: err.length ? JSON.parse(err.join("")) : undefined };
}

const cola = (...rs: Array<{ status: number; body: unknown }>) => respuestas.push(...rs);
const ORG = { status: 200, body: { rut: "76795561-8", razonSocial: "HAULMER SPA" } };

describe("emisor y folios", () => {
  test("emisor consulta /organization", async () => {
    cola(ORG);
    const r = await ejecutar("emisor");
    expect(llamadas[0]).toMatchObject({ url: `${BASE}/organization`, method: "GET" });
    expect(r.out.rut).toBe("76795561-8");
  });

  test("emisor --logo pide el logo", async () => {
    await ejecutar("emisor", "--logo");
    expect(llamadas[0]!.url).toBe(`${BASE}/organization?extra_fields=logo`);
  });

  test("folios consulta /organization/document con GET", async () => {
    await ejecutar("folios");
    expect(llamadas[0]).toMatchObject({ url: `${BASE}/organization/document`, method: "GET" });
  });
});

describe("contribuyente", () => {
  test("normaliza el RUT antes de consultar", async () => {
    cola({ status: 200, body: { rut: "76430498-5", razonSocial: "HOSTY SPA", direccion: "X", actividades: [{ giro: "G" }] } });
    const r = await ejecutar("contribuyente", "76.430.498-5");
    expect(llamadas[0]!.url).toBe(`${BASE}/taxpayer/76430498-5`);
    expect(r.out.encontrado).toBe(true);
  });

  test("un RUT que el SII no conoce sale con encontrado=false, no como si existiera", async () => {
    cola({ status: 200, body: { rut: null, razonSocial: null, direccion: null, actividades: null } });
    const r = await ejecutar("contribuyente", "76795561-8");
    expect(r.out.encontrado).toBe(false);
  });

  test("un RUT existente sin actividad dice que no tiene giro", async () => {
    cola({ status: 200, body: { rut: "11111111-1", razonSocial: "PERSONA", direccion: "X", actividades: [{ giro: null, actividadEconomica: null }] } });
    const r = await ejecutar("contribuyente", "11111111-1");
    expect(r.out.encontrado).toBe(true);
    expect(r.out.tieneGiro).toBe(false);
  });

  test("un RUT con dígito malo falla sin llamar a la API", async () => {
    const r = await ejecutar("contribuyente", "76795561-9");
    expect(r.codigo).toBe(2);
    expect(llamadas).toHaveLength(0);
  });
});

describe("documento", () => {
  test("estado usa el RUT del emisor de la clave cuando no se da --rut", async () => {
    cola(ORG, { status: 200, body: { estado: "Aceptado", folio: "31" } });
    const r = await ejecutar("documento", "estado", "33", "31");
    expect(llamadas[1]!.url).toBe(`${BASE}/document/76795561-8/33/31/status`);
    expect(r.out.estado).toBe("Aceptado");
  });

  test("con --rut consulta el documento de otro emisor (recibidos)", async () => {
    await ejecutar("documento", "estado", "33", "10", "--rut", "76.430.498-5");
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.url).toBe(`${BASE}/document/76430498-5/33/10/status`);
  });

  test("con --token consulta por token", async () => {
    await ejecutar("documento", "json", "--token", "abc123");
    expect(llamadas[0]!.url).toBe(`${BASE}/document/abc123/json`);
  });

  test("pdf decodifica el base64, verifica que sea PDF y lo guarda", async () => {
    const pdf = Buffer.from("%PDF-1.4 contenido").toString("base64");
    cola({ status: 200, body: { pdf, folio: 31 } });
    const archivo = join(dir, "f.pdf");
    const r = await ejecutar("documento", "pdf", "33", "31", "--rut", "76795561-8", "--salida", archivo);
    expect(r.codigo).toBe(0);
    expect(readFileSync(archivo, "utf8")).toBe("%PDF-1.4 contenido");
    expect(r.out).toMatchObject({ archivo, bytes: 18 });
  });

  test("un pdf que no empieza con %PDF falla y no deja archivo", async () => {
    cola({ status: 200, body: { pdf: Buffer.from("<html>error</html>").toString("base64") } });
    const archivo = join(dir, "f.pdf");
    const r = await ejecutar("documento", "pdf", "33", "31", "--rut", "76795561-8", "--salida", archivo);
    expect(r.codigo).toBe(1);
    expect(existsSync(archivo)).toBe(false);
  });

  test("cedible pide /cedible y guarda PDF", async () => {
    cola({ status: 200, body: { pdf: Buffer.from("%PDF-x").toString("base64") } });
    const archivo = join(dir, "c.pdf");
    await ejecutar("documento", "cedible", "33", "31", "--rut", "76795561-8", "--salida", archivo);
    expect(llamadas[0]!.url).toBe(`${BASE}/document/76795561-8/33/31/cedible`);
    expect(existsSync(archivo)).toBe(true);
  });

  test("xml guarda los bytes tal cual vienen, sin recodificar", async () => {
    const bytes = Buffer.from([0x3c, 0x61, 0x3e, 0xcd, 0x3c, 0x2f, 0x61, 0x3e]);
    cola({ status: 200, body: { xml: bytes.toString("base64") } });
    const archivo = join(dir, "d.xml");
    await ejecutar("documento", "xml", "33", "31", "--rut", "76795561-8", "--salida", archivo);
    expect(readFileSync(archivo)).toEqual(bytes);
  });

  test("sin --salida el pdf se guarda con un nombre por tipo y folio", async () => {
    cola({ status: 200, body: { pdf: Buffer.from("%PDF-x").toString("base64") } });
    const antes = process.cwd();
    process.chdir(dir);
    try {
      const r = await ejecutar("documento", "pdf", "61", "1", "--rut", "76795561-8");
      expect(r.out.archivo).toBe("76795561-8_61_1.pdf");
      expect(existsSync(join(dir, "76795561-8_61_1.pdf"))).toBe(true);
    } finally {
      process.chdir(antes);
    }
  });

  test("una acción desconocida sale 2", async () => {
    expect((await ejecutar("documento", "borrar", "33", "1")).codigo).toBe(2);
  });
});

describe("emitidos y recibidos", () => {
  test("emitidos arma los filtros con operadores y el tipo con eq", async () => {
    cola({ status: 200, body: { current_page: 1, last_page: 1, total: 1, data: [{ Folio: 1 }] } });
    await ejecutar("emitidos", "--desde", "2026-09-01", "--hasta", "2026-09-30", "--tipo", "33", "--rut-receptor", "76.430.498-5");
    expect(llamadas[0]).toMatchObject({
      url: `${BASE}/document/issued`,
      method: "POST",
      body: { FchEmis: { gte: "2026-09-01", lte: "2026-09-30" }, TipoDTE: { eq: 33 }, RUTRecep: { eq: 76430498 } },
    });
  });

  test("emitidos sin resultados (204) devuelve una lista vacía", async () => {
    cola({ status: 204, body: null });
    const r = await ejecutar("emitidos", "--tipo", "39");
    expect(r.out).toEqual({ total: 0, paginas: 0, pagina: 1, documentos: [] });
  });

  test("--folio filtra en el cliente, porque la API ignora ese filtro en silencio", async () => {
    cola({ status: 200, body: { current_page: 1, last_page: 1, total: 3, data: [{ Folio: 30 }, { Folio: 31 }, { Folio: 32 }] } });
    const r = await ejecutar("emitidos", "--tipo", "33", "--folio", "31");
    expect((llamadas[0]!.body as Record<string, unknown>).Folio).toBeUndefined();
    expect(r.out.documentos).toEqual([{ Folio: 31 }]);
  });

  test("--todas recorre todas las páginas", async () => {
    cola(
      { status: 200, body: { current_page: 1, last_page: 2, total: 2, data: [{ Folio: 1 }] } },
      { status: 200, body: { current_page: 2, last_page: 2, total: 2, data: [{ Folio: 2 }] } },
    );
    const r = await ejecutar("emitidos", "--todas");
    expect(llamadas).toHaveLength(2);
    expect((llamadas[1]!.body as Record<string, unknown>).Page).toBe(2);
    expect(r.out.documentos).toEqual([{ Folio: 1 }, { Folio: 2 }]);
  });

  test("una fecha mal escrita falla sin llamar", async () => {
    const r = await ejecutar("emitidos", "--desde", "2026-9-1");
    expect(r.codigo).toBe(2);
    expect(llamadas).toHaveLength(0);
  });

  test("un tipo que no es número falla", async () => {
    expect((await ejecutar("emitidos", "--tipo", "factura")).codigo).toBe(2);
  });

  test("recibidos usa RUTEmisor y las fechas de recepción", async () => {
    await ejecutar("recibidos", "--rut-emisor", "76430498-5", "--recepcion-desde", "2026-09-01");
    expect(llamadas[0]).toMatchObject({
      url: `${BASE}/document/received`,
      body: { RUTEmisor: { eq: 76430498 }, FchRecepOF: { gte: "2026-09-01" } },
    });
  });
});

describe("registros del mes", () => {
  test("ventas rellena el mes con cero", async () => {
    await ejecutar("ventas", "2026-9");
    expect(llamadas[0]!.url).toBe(`${BASE}/registry/sales/2026/09`);
  });

  test("ventas de un día", async () => {
    await ejecutar("ventas", "2026-09-05");
    expect(llamadas[0]!.url).toBe(`${BASE}/registry/sales/2026/09/05`);
  });

  test("compras con estado traduce a los valores de la API", async () => {
    await ejecutar("compras", "2026-09", "--estado", "pendiente,registrado");
    expect(llamadas[0]!.url).toBe(`${BASE}/registry/purchase/2026/09?status=pending%2Cregistered`);
  });

  test("un estado de compras desconocido falla", async () => {
    expect((await ejecutar("compras", "2026-09", "--estado", "pagado")).codigo).toBe(2);
  });

  test("sincronizar-rcv manda registro y periodo", async () => {
    await ejecutar("sincronizar-rcv", "compras", "2026-09");
    expect(llamadas[0]).toMatchObject({ url: `${BASE}/registry/sync-rcv`, method: "POST", body: { registro: "purchase", periodo: 202609 } });
  });
});

describe("operaciones que escriben en el SII piden --confirmar", () => {
  test("acusar sin --confirmar no llama y muestra lo que haría", async () => {
    const r = await ejecutar("acusar", "33", "2514", "--rut-emisor", "76795561-8", "--acuse", "ACD");
    expect(llamadas).toHaveLength(0);
    expect(r.out).toMatchObject({ enSeco: true, body: { dte: 33, folio: 2514, rut: "76795561-8", acuse: "ACD" } });
  });

  test("acusar con --confirmar llama", async () => {
    await ejecutar("acusar", "33", "2514", "--rut-emisor", "76795561-8", "--acuse", "rcd", "--confirmar");
    expect(llamadas[0]).toMatchObject({ url: `${BASE}/document/received/accuse`, body: { acuse: "RCD" } });
  });

  test("un acuse desconocido falla", async () => {
    expect((await ejecutar("acusar", "33", "1", "--rut-emisor", "76795561-8", "--acuse", "OK")).codigo).toBe(2);
  });

  test("anular-guia sin --confirmar no llama", async () => {
    const r = await ejecutar("anular-guia", "34972", "--fecha", "2026-09-20");
    expect(llamadas).toHaveLength(0);
    expect(r.out.body).toEqual({ Dte: 52, Folio: 34972, Fecha: "2026-09-20" });
  });

  test("anular-guia con --confirmar llama", async () => {
    await ejecutar("anular-guia", "34972", "--fecha", "2026-09-20", "--confirmar");
    expect(llamadas[0]!.url).toBe(`${BASE}/anularDTE52`);
  });
});
