import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { OpenFacturaClient } from "../src/client.ts";

type Llamada = { url: string; method: string; body: any; headers: Record<string, string> };
let llamadas: Llamada[] = [];
let rutas: Record<string, Array<{ status: number; body: unknown; crudo?: string }>> = {};
const fetchOriginal = globalThis.fetch;
let dir = "";
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

function responde(ruta: string, ...rs: Array<{ status: number; body: unknown; crudo?: string }>) {
  (rutas[ruta] ??= []).push(...rs);
}

beforeEach(() => {
  llamadas = [];
  rutas = {};
  dir = mkdtempSync(join(tmpdir(), "of-"));
  responde("GET /organization", { status: 200, body: ORG });
  responde("GET /taxpayer/76430498-5", { status: 200, body: HOSTY });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const ruta = String(url).replace(BASE, "");
    const metodo = init?.method ?? "GET";
    llamadas.push({ url: ruta, method: metodo, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
    const cola = rutas[`${metodo} ${ruta}`];
    const r = cola && cola.length > 1 ? cola.shift()! : cola?.[0] ?? { status: 404, body: { error: { message: `sin mock ${metodo} ${ruta}`, code: "TEST" } } };
    const texto = r.crudo ?? (r.body == null ? null : JSON.stringify(r.body));
    return new Response(texto, { status: r.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  rmSync(dir, { recursive: true, force: true });
});

async function ejecutar(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const codigo = await run(argv, { OPENFACTURA_API_KEY: "clave-secreta", OPENFACTURA_LIMITE: "0" }, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { codigo, out: out.length ? JSON.parse(out.join("")) : undefined, err: err.length ? JSON.parse(err.join("")) : undefined, errCrudo: err.join("") };
}

const emisiones = () => llamadas.filter((l) => l.method === "POST" && l.url === "/document");
const FACTURA = ["emitir", "factura", "--receptor", "76430498-5", "--item", "Plan|1|1000", "--fecha", "2026-09-27"];
const EMITIDO = { status: 200, body: { TOKEN: "tok1", FOLIO: 77 } };

describe("nada que pueda fallar después de emitir hace perder el folio", () => {
  test("--esperar mal escrito falla ANTES de emitir", async () => {
    responde("POST /document", EMITIDO);
    const r = await ejecutar(...FACTURA, "--confirmar", "--esperar", "abc");
    expect(r.codigo).toBe(2);
    expect(emisiones()).toHaveLength(0);
  });

  test("--intervalo mal escrito falla ANTES de emitir", async () => {
    responde("POST /document", EMITIDO);
    const r = await ejecutar(...FACTURA, "--confirmar", "--esperar", "5", "--intervalo", "x");
    expect(r.codigo).toBe(2);
    expect(emisiones()).toHaveLength(0);
  });

  test("--pdf a una carpeta que no existe falla ANTES de emitir", async () => {
    responde("POST /document", EMITIDO);
    const r = await ejecutar(...FACTURA, "--confirmar", "--pdf", join(dir, "no-existe", "f.pdf"));
    expect(r.codigo).toBe(2);
    expect(emisiones()).toHaveLength(0);
  });

  test("si la consulta de estado falla después de emitir, igual devuelve folio y token con código 0", async () => {
    responde("POST /document", EMITIDO);
    responde("GET /document/tok1/status", { status: 500, body: { error: { message: "caído" } } });
    const r = await ejecutar(...FACTURA, "--confirmar", "--esperar", "5", "--intervalo", "1");
    expect(r.codigo).toBe(0);
    expect(r.out).toMatchObject({ emitido: true, folio: 77, token: "tok1" });
    expect(r.out.avisos.join(" ")).toContain("estado");
  });

  test("--intervalo menor a 1 segundo se rechaza", async () => {
    expect((await ejecutar(...FACTURA, "--confirmar", "--esperar", "5", "--intervalo", "0")).codigo).toBe(2);
    expect(emisiones()).toHaveLength(0);
  });
});

describe("idempotencia", () => {
  test("una --idempotency-key vacía se rechaza", async () => {
    expect((await ejecutar(...FACTURA, "--confirmar", "--idempotency-key", "")).codigo).toBe(2);
    expect((await ejecutar(...FACTURA, "--confirmar", "--idempotency-key", "   ")).codigo).toBe(2);
    expect(emisiones()).toHaveLength(0);
  });

  test("OF-06 con token se informa como ya emitido, con código 0", async () => {
    responde("POST /document", { status: 400, body: { error: { message: "Este DTE ya fue emitido (Idempotency-Key)", code: "OF-06", details: [{ field: "token", issue: "tokviejo" }] } } });
    const r = await ejecutar(...FACTURA, "--confirmar");
    expect(r.codigo).toBe(0);
    expect(r.out).toMatchObject({ emitido: false, yaEmitido: true, token: "tokviejo" });
  });

  test("OF-06 'siendo procesado' sin token también es ya emitido", async () => {
    responde("POST /document", { status: 400, body: { error: { message: "Este DTE está siendo procesado (R).", code: "OF-06" } } });
    const r = await ejecutar(...FACTURA, "--confirmar");
    expect(r.codigo).toBe(0);
    expect(r.out).toMatchObject({ yaEmitido: true, token: null });
  });

  test("un timeout al emitir avisa que pudo haberse emitido", async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const ruta = String(url).replace(BASE, "");
      if (init?.method === "POST") return new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("abort"))));
      if (ruta === "/organization") return new Response(JSON.stringify(ORG));
      return new Response(JSON.stringify(HOSTY));
    }) as typeof fetch;
    const r = await ejecutar(...FACTURA, "--confirmar", "--timeout", "50");
    expect(r.codigo).toBe(1);
    expect(r.err.code).toBe("TIMEOUT");
    expect(r.err.error).toContain("mismo comando");
  });
});

describe("números", () => {
  for (const malo of ["1.000", "1,000", "10.500", "0x3E8", "1e3", "", "1.2345678"]) {
    test(`el precio "${malo}" se rechaza`, async () => {
      const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", `Plan|1|${malo}`, "--fecha", "2026-09-27");
      expect(r.codigo).toBe(2);
    });
  }

  test("precios con decimales razonables se aceptan", async () => {
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "Plan|2|1500,5", "--fecha", "2026-09-27");
    expect(r.out.dte.Detalle[0].PrcItem).toBe(1500.5);
  });

  test("un precio en JSON como string vacío se rechaza", async () => {
    expect((await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", '{"nombre":"x","precio":""}', "--fecha", "2026-09-27")).codigo).toBe(2);
  });

  test("un exento que no es booleano se rechaza", async () => {
    expect((await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", '{"nombre":"x","precio":100,"exento":"true"}', "--fecha", "2026-09-27")).codigo).toBe(2);
  });

  test("un campo desconocido en el JSON del ítem se rechaza", async () => {
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", '{"nombre":"x","precio":100,"exenta":true}', "--fecha", "2026-09-27");
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("exenta");
  });

  test("un monto absurdo se rechaza", async () => {
    expect((await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", '{"nombre":"x","precio":100000000000000000000}', "--fecha", "2026-09-27")).codigo).toBe(2);
  });
});

describe("respuestas raras de la API", () => {
  test("un 200 con HTML al emitir no se informa como emitido", async () => {
    responde("POST /document", { status: 200, body: null, crudo: "<html>proxy</html>" });
    const r = await ejecutar(...FACTURA, "--confirmar");
    expect(r.codigo).toBe(1);
    expect(r.err.code).toBe("RESPUESTA_INVALIDA");
    expect(r.err.error).toContain("mismo comando");
  });

  test("contribuyente con una respuesta que no es JSON falla", async () => {
    rutas["GET /taxpayer/76430498-5"] = [{ status: 200, body: null, crudo: "<html>x</html>" }];
    expect((await ejecutar("contribuyente", "76430498-5")).codigo).toBe(1);
  });

  test("un error {error:'texto'} conserva el texto", async () => {
    responde("POST /document", { status: 400, body: { error: "Folio no disponible" } });
    const r = await ejecutar(...FACTURA, "--confirmar");
    expect(r.err.error).toContain("Folio no disponible");
  });

  test("la clave no aparece aunque venga dentro de details", async () => {
    responde("POST /document", { status: 400, body: { error: { message: "x", code: "OF-10", details: { apikey: "clave-secreta" } } } });
    const r = await ejecutar(...FACTURA, "--confirmar");
    expect(r.errCrudo).not.toContain("clave-secreta");
  });

  test("emitidos --todas no queda en loop si last_page no es un número", async () => {
    responde("POST /document/issued", { status: 200, body: { current_page: 1, last_page: "N/A", total: 1, data: [{ Folio: 1 }] } });
    const r = await ejecutar("emitidos", "--todas");
    expect(r.codigo).toBe(0);
    expect(llamadas.filter((l) => l.url === "/document/issued")).toHaveLength(1);
  });

  test("--pagina 0 se rechaza", async () => {
    expect((await ejecutar("emitidos", "--pagina", "0")).codigo).toBe(2);
  });

  test("un xml en base64 inválido falla", async () => {
    responde("GET /document/76795561-8/33/1/xml", { status: 200, body: { xml: "%%%no-base64%%%" } });
    const r = await ejecutar("documento", "xml", "33", "1", "--rut", "76795561-8", "--salida", join(dir, "a.xml"));
    expect(r.codigo).toBe(1);
  });

  test("un 429 que pide esperar demasiado no se espera", async () => {
    let esperado = 0;
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "Try again in 3600 seconds." }), { status: 429 })) as unknown as typeof fetch;
    const c = new OpenFacturaClient({ apiKey: "k", baseUrl: "https://x", timeoutMs: 1000, esperar: async (ms) => void (esperado += ms) });
    const e = (await c.get("/x").catch((x: unknown) => x)) as { code: string };
    expect(e.code).toBe("RATE_LIMIT");
    expect(esperado).toBe(0);
  });
});

describe("argumentos", () => {
  test("argumentos de más se rechazan en vez de ignorarse", async () => {
    expect((await ejecutar("emitidos", "33")).codigo).toBe(2);
    expect((await ejecutar("documento", "pdf", "33", "10", "--token", "abc")).codigo).toBe(2);
  });

  test("las opciones globales antes del comando funcionan", async () => {
    responde("GET /organization/document", { status: 200, body: { documentos: [] } });
    const r = await ejecutar("--timeout", "5000", "folios");
    expect(r.codigo).toBe(0);
    expect(llamadas.at(-1)!.url).toBe("/organization/document");
    const h = await run(["--help", "emitir"], {}, { out: () => {}, err: () => {} });
    expect(h).toBe(0);
  });

  test("un archivo con BOM se lee", async () => {
    const archivo = join(dir, "dte.json");
    writeFileSync(archivo, "﻿" + JSON.stringify({ Encabezado: { IdDoc: { TipoDTE: 33, Folio: 0 } }, Detalle: [] }));
    expect((await ejecutar("emitir", "archivo", archivo)).codigo).toBe(0);
  });

  test("--salida a una carpeta inexistente sale con código 2", async () => {
    responde("GET /document/76795561-8/33/1/pdf", { status: 200, body: { pdf: Buffer.from("%PDF-1").toString("base64") } });
    const r = await ejecutar("documento", "pdf", "33", "1", "--rut", "76795561-8", "--salida", join(dir, "no", "a.pdf"));
    expect(r.codigo).toBe(2);
  });

  test("el RUT 0-0 no es válido", async () => {
    expect((await ejecutar("contribuyente", "0-0")).codigo).toBe(2);
  });

  test("una fecha de emisión anterior al 2000 se rechaza", async () => {
    expect((await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "x|1|1000", "--fecha", "0000-01-01")).codigo).toBe(2);
  });

  test("el resumen dice en qué ambiente se va a emitir", async () => {
    const r = await ejecutar(...FACTURA);
    expect(r.out.ambiente).toBe("prod");
  });
});
