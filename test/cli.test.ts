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

const ENV = { OPENFACTURA_API_KEY: "k", OPENFACTURA_LIMITE: "0" };

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
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "mal", code: "OF-22" } }), { status: 400 })) as unknown as typeof fetch;
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

describe("errores de uso antes de pedir la clave", () => {
  for (const argv of [["emitir"], ["contribuyente"], ["documento"], ["acusar", "33"], ["ventas"], ["sincronizar-rcv", "ventas"], ["anular-guia"]]) {
    test(`${argv.join(" ")} sin clave avisa lo que falta, no la clave`, async () => {
      const c = capturar();
      expect(await run(argv, {}, c.io)).toBe(2);
      expect(JSON.parse(c.err.join(""))).toMatchObject({ code: "USAGE" });
    });
  }

  test("argumentos de más sin clave también es de uso", async () => {
    const c = capturar();
    expect(await run(["emisor", "sobra"], {}, c.io)).toBe(2);
    expect(JSON.parse(c.err.join(""))).toMatchObject({ code: "USAGE" });
  });
});

test("--version es la versión de package.json", async () => {
  const pkg = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text());
  const c = capturar();
  expect(await run(["--version"], ENV, c.io)).toBe(0);
  expect(c.out.join("").trim()).toBe(pkg.version);
});

describe("atajos de ayuda", () => {
  test("-v también muestra la versión", async () => {
    const c = capturar();
    expect(await run(["-v"], ENV, c.io)).toBe(0);
    expect(c.out.join("").trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("help sin nada muestra la ayuda general", async () => {
    const c = capturar();
    expect(await run(["help"], ENV, c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("Uso:");
  });

  test("help <comando> muestra la ayuda de ese comando", async () => {
    const c = capturar();
    expect(await run(["help", "folios"], ENV, c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("openfactura folios");
  });
});

describe("errores de opciones en español", () => {
  const casos: Array<[string[], RegExp]> = [
    [["emitidos", "--nada"], /La opción --nada no existe/],
    [["emitidos", "--desde"], /--desde necesita un valor/],
    [["emitidos", "--todas=si"], /--todas no lleva valor/],
  ];
  for (const [argv, esperado] of casos) {
    test(argv.join(" "), async () => {
      const c = capturar();
      expect(await run(argv, ENV, c.io)).toBe(2);
      const e = JSON.parse(c.err.join(""));
      expect(e.code).toBe("USAGE");
      expect(e.error).toMatch(esperado);
      expect(e.error).toContain("openfactura emitidos --help");
    });
  }
});
