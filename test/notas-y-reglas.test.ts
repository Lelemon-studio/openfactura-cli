import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { run } from "../src/cli.ts";

type Llamada = { url: string; method: string; body: any; headers: Record<string, string> };
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
const HOSTY = {
  rut: "76430498-5",
  razonSocial: "HOSTY SPA",
  direccion: "PRAT 527",
  comuna: "Curicó",
  actividades: [{ giro: "CONSULTORIA", codigoActividadEconomica: "620200", actividadPrincipal: true }],
};
const EMISOR_PROPIO = { RUTEmisor: "76795561-8" };
const RECEPTOR = { RUTRecep: "76430498-5", RznSocRecep: "HOSTY SPA", GiroRecep: "SERVICIOS", DirRecep: "MONTT 152", CmnaRecep: "Curicó" };

function doc(tipo: number, fecha: string, extra: object) {
  return {
    status: 200,
    body: {
      json: {
        Encabezado: { IdDoc: { TipoDTE: tipo, FchEmis: fecha }, Emisor: EMISOR_PROPIO, Receptor: RECEPTOR, ...extra },
        Detalle: [{ NroLinDet: 1, NmbItem: "A", QtyItem: 1, PrcItem: 10000, MontoItem: 10000 }],
      },
    },
  };
}
const TOT_30 = { Totales: { MntNeto: 10000, TasaIVA: 19, IVA: 1900, MntTotal: 11900 } };

function responde(ruta: string, ...rs: Array<{ status: number; body: unknown }>) {
  rutas[ruta] = [...(rutas[ruta] ?? []), ...rs];
}

beforeEach(() => {
  llamadas = [];
  rutas = {};
  responde("GET /organization", { status: 200, body: ORG });
  responde("GET /taxpayer/76430498-5", { status: 200, body: HOSTY });
  responde("GET /document/76795561-8/33/30/json", doc(33, "2026-09-20", TOT_30));
  responde("POST /document/issued", { status: 204, body: null });
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
    const r = (cola && cola.length > 1 ? cola.shift() : cola?.[0]) ?? { status: 404, body: { error: { message: `sin mock ${metodo} ${ruta}`, code: "TEST" } } };
    return new Response(r.body == null ? null : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

async function ejecutar(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const codigo = await run(argv, { OPENFACTURA_API_KEY: "k", OPENFACTURA_LIMITE: "0" }, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { codigo, out: out.length ? JSON.parse(out.join("")) : undefined, err: err.length ? JSON.parse(err.join("")) : undefined, errCrudo: err.join("") };
}

const HOY = ["--fecha", "2026-09-27"];
const emisiones = () => llamadas.filter((l) => l.method === "POST" && l.url === "/document");

describe("clave de idempotencia dada a mano", () => {
  test("la misma clave con otro documento lleva otra Idempotency-Key", async () => {
    responde("POST /document", { status: 200, body: { TOKEN: "t", FOLIO: 1 } });
    await ejecutar("emitir", "boleta", "--item", "Cafe|1|1500", "--idempotency-key", "pedido-1", ...HOY, "--confirmar");
    await ejecutar("emitir", "boleta", "--item", "Te|2|2500", "--idempotency-key", "pedido-1", ...HOY, "--confirmar");
    const [a, b] = emisiones();
    expect(a!.headers["Idempotency-Key"]).not.toBe(b!.headers["Idempotency-Key"]!);
  });

  test("la misma clave con el mismo documento sigue siendo idempotente", async () => {
    responde("POST /document", { status: 200, body: { TOKEN: "t", FOLIO: 1 } });
    await ejecutar("emitir", "boleta", "--item", "Cafe|1|1500", "--idempotency-key", "pedido-1", ...HOY, "--confirmar");
    await ejecutar("emitir", "boleta", "--item", "Cafe|1|1500", "--idempotency-key", "pedido-1", ...HOY, "--confirmar");
    const [a, b] = emisiones();
    expect(a!.headers["Idempotency-Key"]).toBe(b!.headers["Idempotency-Key"]!);
  });

  test("un timeout al emitir informa la fecha y la clave para repetir igual", async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const ruta = String(url).replace(BASE, "");
      if (init?.method === "POST") return new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("abort"))));
      return new Response(JSON.stringify(ruta === "/organization" ? ORG : HOSTY));
    }) as typeof fetch;
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "x|1|1000", ...HOY, "--confirmar", "--timeout", "50");
    expect(r.err.code).toBe("TIMEOUT");
    expect(r.err.details).toMatchObject({ fecha: "2026-09-27" });
    expect(r.err.details.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("nota de débito", () => {
  test("--anula sólo sobre una nota de crédito", async () => {
    const r = await ejecutar("emitir", "nota-debito", "--referencia", "33:30", "--anula", ...HOY);
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("nota de crédito");
  });
});

describe("notas de crédito acumuladas", () => {
  test("suma las notas ya emitidas contra el mismo documento y bloquea si se pasan", async () => {
    rutas["POST /document/issued"] = [
      {
        status: 200,
        body: {
          current_page: 1,
          last_page: 1,
          total: 2,
          data: [
            { TipoDTE: 61, Folio: 7 },
            { TipoDTE: 61, Folio: 8 },
          ],
        },
      },
    ];
    responde("GET /document/76795561-8/61/7/json", {
      status: 200,
      body: {
        json: {
          Encabezado: { Totales: { MntNeto: 8000, TasaIVA: 19, IVA: 1520, MntTotal: 9520 } },
          Referencia: [{ TpoDocRef: "33", FolioRef: 30, CodRef: 3 }],
        },
      },
    });
    responde("GET /document/76795561-8/61/8/json", {
      status: 200,
      body: {
        json: { Encabezado: { Totales: { MntNeto: 5000, TasaIVA: 19, IVA: 950, MntTotal: 5950 } }, Referencia: [{ TpoDocRef: "33", FolioRef: 99, CodRef: 3 }] },
      },
    });
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "33:30", "--corrige-montos", "--item", "x|1|3000", ...HOY);
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("61:7");
  });

  test("una anulación después de una nota parcial también se bloquea", async () => {
    rutas["POST /document/issued"] = [{ status: 200, body: { current_page: 1, last_page: 1, total: 1, data: [{ TipoDTE: 61, Folio: 7 }] } }];
    responde("GET /document/76795561-8/61/7/json", {
      status: 200,
      body: {
        json: { Encabezado: { Totales: { MntNeto: 3000, TasaIVA: 19, IVA: 570, MntTotal: 3570 } }, Referencia: [{ TpoDocRef: "33", FolioRef: 30, CodRef: 3 }] },
      },
    });
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "33:30", "--anula", ...HOY);
    expect(r.codigo).toBe(2);
  });

  test("las notas que sólo corrigen texto no cuentan", async () => {
    rutas["POST /document/issued"] = [{ status: 200, body: { current_page: 1, last_page: 1, total: 1, data: [{ TipoDTE: 61, Folio: 7 }] } }];
    responde("GET /document/76795561-8/61/7/json", {
      status: 200,
      body: { json: { Encabezado: { Totales: { MntNeto: 0, IVA: 0, MntTotal: 0 } }, Referencia: [{ TpoDocRef: "33", FolioRef: 30, CodRef: 2 }] } },
    });
    expect((await ejecutar("emitir", "nota-credito", "--referencia", "33:30", "--anula", ...HOY)).codigo).toBe(0);
  });

  test("si hay más notas que las que revisa, avisa que la suma puede estar incompleta", async () => {
    rutas["POST /document/issued"] = [{ status: 200, body: { current_page: 1, last_page: 50, total: 50, data: [] } }];
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "33:30", "--corrige-montos", "--item", "x|1|1000", ...HOY);
    expect(r.codigo).toBe(0);
    expect(r.out.avisos.join(" ")).toContain("sólo se revisaron");
  });

  test("si falla una página de notas previas, igual cuenta las que ya vio", async () => {
    rutas["POST /document/issued"] = [
      { status: 200, body: { current_page: 1, last_page: 2, total: 2, data: [{ TipoDTE: 61, Folio: 7 }] } },
      { status: 500, body: { error: { message: "caído" } } },
    ];
    responde("GET /document/76795561-8/61/7/json", {
      status: 200,
      body: {
        json: {
          Encabezado: { Totales: { MntNeto: 8000, TasaIVA: 19, IVA: 1520, MntTotal: 9520 } },
          Referencia: [{ TpoDocRef: "33", FolioRef: 30, CodRef: 3 }],
        },
      },
    });
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "33:30", "--corrige-montos", "--item", "x|1|3000", ...HOY);
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("61:7");
  });

  test("una nota que aparece en dos páginas se cuenta una vez", async () => {
    const pagina = { status: 200, body: { current_page: 1, last_page: 2, total: 2, data: [{ TipoDTE: 61, Folio: 7 }] } };
    rutas["POST /document/issued"] = [pagina, pagina];
    responde("GET /document/76795561-8/61/7/json", {
      status: 200,
      body: {
        json: { Encabezado: { Totales: { MntNeto: 4000, TasaIVA: 19, IVA: 760, MntTotal: 4760 } }, Referencia: [{ TpoDocRef: "33", FolioRef: 30, CodRef: 3 }] },
      },
    });
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "33:30", "--corrige-montos", "--item", "x|1|3000", ...HOY);
    expect(r.codigo).toBe(0);
  });

  test("si una página de notas previas llega vacía antes de la última, avisa", async () => {
    rutas["POST /document/issued"] = [
      { status: 200, body: { current_page: 1, last_page: 3, total: 3, data: [] } },
      { status: 204, body: null },
    ];
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "33:30", "--corrige-montos", "--item", "x|1|1000", ...HOY);
    expect(r.codigo).toBe(0);
    expect(r.out.avisos.join(" ")).toContain("puede estar incompleta");
  });

  test("si no puede revisar las notas previas, avisa", async () => {
    rutas["POST /document/issued"] = [{ status: 500, body: { error: { message: "caído" } } }];
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "33:30", "--corrige-montos", "--item", "x|1|1000", ...HOY);
    expect(r.codigo).toBe(0);
    expect(r.out.avisos.join(" ")).toContain("No se pudo revisar");
  });
});

describe("el original tiene que ser coherente", () => {
  test("anular una boleta sin neto ni IVA los recalcula desde el total", async () => {
    responde("GET /document/76795561-8/39/5/json", {
      status: 200,
      body: {
        json: {
          Encabezado: {
            IdDoc: { TipoDTE: 39, FchEmis: "2026-09-20" },
            Emisor: EMISOR_PROPIO,
            Receptor: { RUTRecep: "66666666-6", RznSocRecep: "Cliente" },
            Totales: { MntTotal: 11900 },
          },
          Detalle: [{ NroLinDet: 1, NmbItem: "x", QtyItem: 1, PrcItem: 11900, MontoItem: 11900 }],
        },
      },
    });
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "39:5", "--anula", ...HOY);
    expect(r.out.dte.Encabezado.Totales).toEqual({ MntNeto: 10000, TasaIVA: 19, IVA: 1900, MntTotal: 11900 });
  });

  test("un original con impuestos adicionales o descuentos globales no se anula copiando", async () => {
    responde("GET /document/76795561-8/33/31/json", {
      status: 200,
      body: {
        json: {
          Encabezado: {
            IdDoc: { TipoDTE: 33, FchEmis: "2026-09-20" },
            Emisor: EMISOR_PROPIO,
            Receptor: RECEPTOR,
            Totales: { MntNeto: 9000, IVA: 1710, ImptoReten: [{ TipoImp: 27, MontoImp: 900 }], MntTotal: 11610 },
          },
          Detalle: [{ NroLinDet: 1, NmbItem: "x", QtyItem: 1, PrcItem: 9000, MontoItem: 9000 }],
        },
      },
    });
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "33:31", "--anula", ...HOY);
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("archivo");
  });

  test("un original sin totales no se puede referenciar", async () => {
    responde("GET /document/76795561-8/33/32/json", {
      status: 200,
      body: { json: { Encabezado: { IdDoc: { TipoDTE: 33, FchEmis: "2026-09-20" }, Emisor: EMISOR_PROPIO, Receptor: RECEPTOR }, Detalle: [] } },
    });
    expect((await ejecutar("emitir", "nota-credito", "--referencia", "33:32", "--anula", ...HOY)).codigo).toBe(2);
  });

  test("totales que no son números se rechazan", async () => {
    responde("GET /document/76795561-8/33/33/json", doc(33, "2026-09-20", { Totales: { MntNeto: "N/D", IVA: 1900, MntTotal: 11900 } }));
    expect((await ejecutar("emitir", "nota-credito", "--referencia", "33:33", "--corrige-montos", "--item", "x|1|1000", ...HOY)).codigo).toBe(2);
  });

  test("un original sin RUT de receptor se rechaza con un mensaje claro", async () => {
    responde("GET /document/76795561-8/33/34/json", {
      status: 200,
      body: {
        json: { Encabezado: { IdDoc: { TipoDTE: 33, FchEmis: "2026-09-20" }, Emisor: EMISOR_PROPIO, Receptor: { RznSocRecep: "X" }, ...TOT_30 }, Detalle: [] },
      },
    });
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "33:34", "--corrige-montos", "--item", "x|1|1000", ...HOY);
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("receptor");
  });

  test("no se puede emitir nota sobre un documento de otro emisor", async () => {
    responde("GET /document/76795561-8/33/35/json", {
      status: 200,
      body: {
        json: {
          Encabezado: { IdDoc: { TipoDTE: 33, FchEmis: "2026-09-20" }, Emisor: { RUTEmisor: "10000013-K" }, Receptor: RECEPTOR, ...TOT_30 },
          Detalle: [],
        },
      },
    });
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "33:35", "--corrige-montos", "--item", "x|1|1000", ...HOY);
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("emisor");
  });

  test("el plazo de 6 meses no avisa por error a fin de mes", async () => {
    responde("GET /document/76795561-8/33/36/json", doc(33, "2026-03-02", TOT_30));
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "33:36", "--corrige-montos", "--item", "x|1|1000", "--fecha", "2026-08-31");
    expect(r.out.avisos.join(" ")).not.toContain("6 meses");
  });
});

describe("guía: los datos de la Res. 154 no se esquivan con espacios", () => {
  test("una patente o un chofer en blanco cuentan como faltantes", async () => {
    const r = await ejecutar(
      "emitir",
      "guia",
      "--receptor",
      "76430498-5",
      "--item",
      "Caja|1|1000",
      "--traslado",
      "venta",
      "--destino-direccion",
      "Calle",
      "--destino-comuna",
      "Talca",
      "--chofer-rut",
      "11111111-1",
      "--chofer-nombre",
      " ",
      "--transportista-rut",
      "76430498-5",
      "--patente=---",
      "--fecha",
      "2026-11-02",
    );
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("--patente");
    expect(r.err.error).toContain("--chofer-nombre");
  });
});

describe("topes y opciones", () => {
  test("--intervalo y --esperar tienen tope", async () => {
    expect((await ejecutar("emitir", "boleta", "--item", "x|1|1190", "--esperar", "1", "--intervalo", "3000000", ...HOY)).codigo).toBe(2);
    expect((await ejecutar("emitir", "boleta", "--item", "x|1|1190", "--esperar", "99999", ...HOY)).codigo).toBe(2);
  });

  test("--timeout tiene tope", async () => {
    expect((await ejecutar("--timeout", "3000000000", "folios")).codigo).toBe(2);
  });

  test("una opción global sin valor falla", async () => {
    expect((await ejecutar("--timeout", "emitir", "factura")).codigo).toBe(2);
    expect((await ejecutar("--api-key")).codigo).toBe(2);
  });

  test("0.500 no se trata como separador de miles", async () => {
    const r = await ejecutar("emitir", "boleta", "--item", "Queso|0.500|8000", ...HOY);
    expect(r.codigo).toBe(0);
    expect(r.out.dte.Detalle[0].MontoItem).toBe(4000);
  });

  test("un monto de línea gigante se rechaza", async () => {
    expect((await ejecutar("emitir", "boleta", "--item", "X|99999999|99999999", ...HOY)).codigo).toBe(2);
  });

  test("--pdf vacío se rechaza", async () => {
    expect((await ejecutar("emitir", "boleta", "--item", "x|1|1190", "--pdf", "", ...HOY)).codigo).toBe(2);
  });

  test("--con-iva en una nota sobre boleta o documento exento se rechaza", async () => {
    responde("GET /document/76795561-8/34/5/json", {
      status: 200,
      body: {
        json: {
          Encabezado: { IdDoc: { TipoDTE: 34, FchEmis: "2026-09-20" }, Emisor: EMISOR_PROPIO, Receptor: RECEPTOR, Totales: { MntExe: 5000, MntTotal: 5000 } },
          Detalle: [],
        },
      },
    });
    expect((await ejecutar("emitir", "nota-credito", "--referencia", "34:5", "--corrige-montos", "--item", "x|1|1000", "--con-iva", ...HOY)).codigo).toBe(2);
  });

  test("el correo de un archivo se valida", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const archivo = join(mkdtempSync(join(tmpdir(), "of-")), "b.json");
    writeFileSync(archivo, JSON.stringify({ sendEmail: { to: "no-es-correo" }, dte: { Encabezado: { IdDoc: { TipoDTE: 33, Folio: 0 } }, Detalle: [] } }));
    expect((await ejecutar("emitir", "archivo", archivo)).codigo).toBe(2);
  });
});

describe("formato del SII", () => {
  test("una línea con precio cero no manda PrcItem", async () => {
    const r = await ejecutar("emitir", "guia", "--receptor", "76430498-5", "--item", "Caja|3|0", "--traslado", "interno", ...HOY);
    expect(r.out.dte.Detalle[0].PrcItem).toBeUndefined();
    expect(r.out.dte.Detalle[0].MontoItem).toBe(0);
  });

  test("corregir texto no manda PrcItem en cero", async () => {
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "33:30", "--corrige-texto", "--razon", "Corrige giro", ...HOY);
    expect(r.out.dte.Detalle[0].PrcItem).toBeUndefined();
  });

  test("--ref en boleta se rechaza: la boleta tiene otro esquema de referencias", async () => {
    expect((await ejecutar("emitir", "boleta", "--item", "x|1|1190", "--ref", "801:OC-1:2026-09-01", ...HOY)).codigo).toBe(2);
  });

  test("el DTE sale en el orden del XSD", async () => {
    const r = await ejecutar(
      "emitir",
      "factura",
      "--receptor",
      "76430498-5",
      "--item",
      "x|1|1000|exento",
      "--item",
      "y|1|1000",
      "--correo",
      "a@example.com",
      ...HOY,
    );
    expect(Object.keys(r.out.dte.Encabezado.Receptor)).toEqual(["RUTRecep", "RznSocRecep", "GiroRecep", "CorreoRecep", "DirRecep", "CmnaRecep"]);
    expect(Object.keys(r.out.dte.Detalle[0])[1]).toBe("IndExe");
  });

  test("una dirección del SII demasiado larga se recorta con aviso", async () => {
    rutas["GET /taxpayer/76430498-5"] = [{ status: 200, body: { ...HOSTY, direccion: "CALLE ".repeat(15) } }];
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "x|1|1000", ...HOY);
    expect(r.out.dte.Encabezado.Receptor.DirRecep.length).toBeLessThanOrEqual(70);
    expect(r.out.avisos.join(" ")).toContain("dirección");
  });

  test("una comuna escrita a mano demasiado larga es error", async () => {
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--comuna", "x".repeat(21), "--item", "x|1|1000", ...HOY);
    expect(r.codigo).toBe(2);
    expect(r.err.error).toContain("CmnaRecep");
  });
});

describe("errores de la API con contexto", () => {
  test("si falla la lectura del documento referenciado, el error dice cuál era", async () => {
    const r = await ejecutar("emitir", "nota-credito", "--referencia", "33:777", "--anula", ...HOY);
    expect(r.codigo).toBe(1);
    expect(r.err.error).toContain("33 folio 777");
  });

  test("lo mismo con una --ref sin fecha", async () => {
    const r = await ejecutar("emitir", "factura", "--receptor", "76430498-5", "--item", "x|1|1000", "--ref", "52:123", ...HOY);
    expect(r.codigo).toBe(1);
    expect(r.err.error).toContain("52 folio 123");
  });
});
