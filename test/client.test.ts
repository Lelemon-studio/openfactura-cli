import { afterEach, describe, expect, test } from "bun:test";
import { OpenFacturaClient, ApiError } from "../src/client.ts";

type Llamada = { url: string; init: RequestInit };
const llamadas: Llamada[] = [];
const fetchOriginal = globalThis.fetch;

function responder(status: number, body: string | object | null, headers: Record<string, string> = {}) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init: init ?? {} });
    const texto = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
    return new Response(texto, { status, headers });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  llamadas.length = 0;
});

async function fallo(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("se esperaba un error");
}

const cliente = () => new OpenFacturaClient({ apiKey: "clave-secreta", baseUrl: "https://api.test/v2/dte", timeoutMs: 1000 });

describe("OpenFacturaClient", () => {
  test("manda la clave en el header apikey y arma la URL con la base", async () => {
    responder(200, { ok: 1 });
    await cliente().get("/organization");
    expect(llamadas[0]!.url).toBe("https://api.test/v2/dte/organization");
    expect((llamadas[0]!.init.headers as Record<string, string>).apikey).toBe("clave-secreta");
  });

  test("devuelve el JSON parseado", async () => {
    responder(200, { rut: "1-9" });
    expect(await cliente().get("/organization")).toEqual({ rut: "1-9" });
  });

  test("un 204 sin cuerpo devuelve null en vez de reventar", async () => {
    responder(204, null);
    expect(await cliente().post("/document/issued", {})).toBeNull();
  });

  test("un 200 con cuerpo vacío también devuelve null", async () => {
    responder(200, "");
    expect(await cliente().get("/x")).toBeNull();
  });

  test("POST manda el body como JSON", async () => {
    responder(200, {});
    await cliente().post("/document", { a: 1 });
    expect(llamadas[0]!.init.method).toBe("POST");
    expect(llamadas[0]!.init.body).toBe('{"a":1}');
    expect((llamadas[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  test("pasa la Idempotency-Key cuando se la dan", async () => {
    responder(200, {});
    await cliente().post("/document", {}, { idempotencyKey: "abc" });
    expect((llamadas[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("abc");
  });

  test("un error de OpenFactura se convierte en ApiError con código y detalle", async () => {
    responder(400, { error: { message: "Error de esquema", code: "OF-08", details: [{ field: "IdDoc", issue: "falta" }] } });
    const e = await fallo(cliente().post("/document", {}));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(400);
    expect(e.code).toBe("OF-08");
    expect(e.message).toContain("Error de esquema");
    expect(e.details).toEqual([{ field: "IdDoc", issue: "falta" }]);
  });

  test("un error con código arriba y details como objeto también se lee", async () => {
    responder(400, { message: "Validación de Campos.", code: "OF-10", details: { TipoDTE: ["debe ser un arreglo"] } });
    const e = await fallo(cliente().post("/document/issued", {}));
    expect(e.code).toBe("OF-10");
    expect(e.message).toContain("Validación de Campos.");
    expect(e.details).toEqual({ TipoDTE: ["debe ser un arreglo"] });
  });

  test("el rechazo del gateway por clave inválida sale como AUTH", async () => {
    responder(401, { statusCode: 401, message: "Access denied due to invalid subscription key." });
    const e = await fallo(cliente().get("/organization"));
    expect(e.status).toBe(401);
    expect(e.code).toBe("AUTH");
    expect(e.message).toContain("invalid subscription key");
  });

  test("una respuesta en Latin-1 conserva las tildes", async () => {
    const latin1 = new Uint8Array([...'{"razon":"CONSULTOR'].map((c) => c.charCodeAt(0)).concat([0xcd], [...'A"}'].map((c) => c.charCodeAt(0))));
    globalThis.fetch = (async () => new Response(latin1, { status: 200 })) as unknown as typeof fetch;
    expect(await cliente().get("/x")).toEqual({ razon: "CONSULTORÍA" });
  });

  test("una respuesta en UTF-8 no se reinterpreta", async () => {
    responder(200, { comuna: "Curicó" });
    expect(await cliente().get("/x")).toEqual({ comuna: "Curicó" });
  });

  test("un error que no es JSON conserva el texto", async () => {
    responder(502, "Bad Gateway");
    const e = await fallo(cliente().get("/x"));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(502);
    expect(e.message).toContain("Bad Gateway");
  });

  test("el mensaje de error nunca contiene la clave", async () => {
    responder(401, { error: { message: "apikey clave-secreta invalida", code: "OF-03" } });
    const e = await fallo(cliente().get("/x"));
    expect(e.message).not.toContain("clave-secreta");
    expect(JSON.stringify(e.toJSON())).not.toContain("clave-secreta");
  });

  test("un 200 con WARNING lo expone sin tratarlo como error", async () => {
    responder(200, { FOLIO: 5, WARNING: "GiroRecep truncado" });
    expect(await cliente().post("/document", {})).toEqual({ FOLIO: 5, WARNING: "GiroRecep truncado" });
  });

  test("ante un 429 espera lo que pide la API y reintenta", async () => {
    const respuestas = [
      new Response(JSON.stringify({ statusCode: 429, message: "Rate limit is exceeded. Try again in 1 seconds." }), { status: 429 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ];
    const esperas: number[] = [];
    globalThis.fetch = (async () => respuestas.shift()!) as unknown as typeof fetch;
    const c = new OpenFacturaClient({ apiKey: "k", baseUrl: "https://api.test", timeoutMs: 1000, esperar: async (ms) => void esperas.push(ms) });
    expect(await c.post("/document", {}, { idempotencyKey: "x" })).toEqual({ ok: true });
    expect(esperas).toEqual([1000]);
  });

  test("si el 429 no dice cuánto esperar, espera un segundo", async () => {
    const respuestas = [new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 429 }), new Response("{}", { status: 200 })];
    const esperas: number[] = [];
    globalThis.fetch = (async () => respuestas.shift()!) as unknown as typeof fetch;
    const c = new OpenFacturaClient({ apiKey: "k", baseUrl: "https://api.test", timeoutMs: 1000, esperar: async (ms) => void esperas.push(ms) });
    await c.get("/x");
    expect(esperas).toEqual([1000]);
  });

  test("después de tres 429 seguidos se rinde con RATE_LIMIT", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "Try again in 2 seconds." }), { status: 429 })) as unknown as typeof fetch;
    let intentos = 0;
    const c = new OpenFacturaClient({ apiKey: "k", baseUrl: "https://api.test", timeoutMs: 1000, esperar: async () => void intentos++ });
    const e = await fallo(c.get("/x"));
    expect(e.code).toBe("RATE_LIMIT");
    expect(intentos).toBe(3);
  });

  test("el OF-429 de sync-rcv no se reintenta: trae su propio plazo", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Límite", code: "OF-429", details: { retry_after: 600 } } }), { status: 429 })) as unknown as typeof fetch;
    let intentos = 0;
    const c = new OpenFacturaClient({ apiKey: "k", baseUrl: "https://api.test", timeoutMs: 1000, esperar: async () => void intentos++ });
    const e = await fallo(c.post("/registry/sync-rcv", {}));
    expect(e.code).toBe("OF-429");
    expect(intentos).toBe(0);
  });

  test("si la API no responde a tiempo lanza ApiError de timeout", async () => {
    globalThis.fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("t", "TimeoutError"))))) as typeof fetch;
    const c = new OpenFacturaClient({ apiKey: "k", baseUrl: "https://api.test", timeoutMs: 20 });
    const e = await fallo(c.get("/x"));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe("TIMEOUT");
  });
});
