import { afterEach, describe, expect, test } from "bun:test";
import { run } from "../src/cli.ts";

const fetchOriginal = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

function capturar() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

const ENV = { OPENFACTURA_API_KEY: "k" };

describe("cli", () => {
  test("--help lista los comandos y sale 0", async () => {
    const c = capturar();
    expect(await run(["--help"], ENV, c.io)).toBe(0);
    const texto = c.out.join("\n");
    expect(texto).toContain("emisor");
    expect(texto).toContain("emitir");
  });

  test("sin argumentos muestra la ayuda", async () => {
    const c = capturar();
    expect(await run([], ENV, c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("Uso:");
  });

  test("un comando desconocido sale 2 con error JSON en stderr", async () => {
    const c = capturar();
    expect(await run(["volar"], ENV, c.io)).toBe(2);
    expect(JSON.parse(c.err.join(""))).toMatchObject({ code: "USAGE" });
    expect(c.out).toEqual([]);
  });

  test("sin clave sale 2 con código CONFIG", async () => {
    const c = capturar();
    expect(await run(["emisor"], {}, c.io)).toBe(2);
    expect(JSON.parse(c.err.join(""))).toMatchObject({ code: "CONFIG" });
  });

  test("un error de la API sale 1 con el código de OpenFactura", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "mal", code: "OF-22" } }), { status: 400 })) as unknown as typeof fetch;
    const c = capturar();
    expect(await run(["emisor"], ENV, c.io)).toBe(1);
    expect(JSON.parse(c.err.join(""))).toMatchObject({ code: "OF-22", status: 400 });
  });

  test("el resultado sale como JSON en stdout", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ rut: "76795561-8" }), { status: 200 })) as unknown as typeof fetch;
    const c = capturar();
    expect(await run(["emisor"], ENV, c.io)).toBe(0);
    expect(JSON.parse(c.out.join(""))).toEqual({ rut: "76795561-8" });
  });

  test("--help de un comando muestra su uso", async () => {
    const c = capturar();
    expect(await run(["emisor", "--help"], ENV, c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("openfactura emisor");
  });

  test("--version imprime la versión", async () => {
    const c = capturar();
    expect(await run(["--version"], ENV, c.io)).toBe(0);
    expect(c.out.join("")).toMatch(/\d+\.\d+\.\d+/);
  });

  test("un flag desconocido sale 2 en vez de ignorarse", async () => {
    const c = capturar();
    expect(await run(["emisor", "--rut-emisro", "1"], ENV, c.io)).toBe(2);
    expect(JSON.parse(c.err.join(""))).toMatchObject({ code: "USAGE" });
  });
});
