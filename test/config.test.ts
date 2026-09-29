import { describe, expect, test } from "bun:test";
import { resolveConfig, ConfigError } from "../src/config.ts";

describe("resolveConfig", () => {
  test("la clave del flag gana sobre las variables de entorno", () => {
    const c = resolveConfig({ apiKey: "flag" }, { OPENFACTURA_API_KEY: "env", OPENFACTURA_KEY: "old" });
    expect(c.apiKey).toBe("flag");
  });

  test("OPENFACTURA_API_KEY gana sobre OPENFACTURA_KEY", () => {
    const c = resolveConfig({}, { OPENFACTURA_API_KEY: "nueva", OPENFACTURA_KEY: "vieja" });
    expect(c.apiKey).toBe("nueva");
  });

  test("acepta OPENFACTURA_KEY como respaldo", () => {
    expect(resolveConfig({}, { OPENFACTURA_KEY: "vieja" }).apiKey).toBe("vieja");
  });

  test("sin clave lanza un error que dice de dónde se lee", () => {
    expect(() => resolveConfig({}, {})).toThrow(ConfigError);
    expect(() => resolveConfig({}, {})).toThrow(/OPENFACTURA_API_KEY/);
  });

  test("una clave con espacios alrededor se recorta", () => {
    expect(resolveConfig({}, { OPENFACTURA_API_KEY: "  abc \n" }).apiKey).toBe("abc");
  });

  test("producción es el ambiente por defecto", () => {
    expect(resolveConfig({}, { OPENFACTURA_API_KEY: "k" }).baseUrl).toBe("https://api.haulmer.com/v2/dte");
  });

  test("--dev apunta a dev-api", () => {
    const c = resolveConfig({ dev: true }, { OPENFACTURA_API_KEY: "k" });
    expect(c.baseUrl).toBe("https://dev-api.haulmer.com/v2/dte");
    expect(c.env).toBe("dev");
  });

  test("OPENFACTURA_ENV=dev también apunta a dev-api", () => {
    expect(resolveConfig({}, { OPENFACTURA_API_KEY: "k", OPENFACTURA_ENV: "dev" }).env).toBe("dev");
  });

  test("un OPENFACTURA_ENV desconocido falla en vez de caer a producción", () => {
    expect(() => resolveConfig({}, { OPENFACTURA_API_KEY: "k", OPENFACTURA_ENV: "staging" })).toThrow(ConfigError);
  });
});

describe("OPENFACTURA_LIMITE", () => {
  test("por defecto limita a 3 por segundo y 100 por minuto", () => {
    expect(resolveConfig({}, { OPENFACTURA_API_KEY: "k" }).limite).toEqual({ porSegundo: 3, porMinuto: 100 });
  });

  test("se puede ajustar", () => {
    expect(resolveConfig({}, { OPENFACTURA_API_KEY: "k", OPENFACTURA_LIMITE: "5/200" }).limite).toEqual({ porSegundo: 5, porMinuto: 200 });
  });

  test("0 lo desactiva", () => {
    expect(resolveConfig({}, { OPENFACTURA_API_KEY: "k", OPENFACTURA_LIMITE: "0" }).limite).toBeNull();
  });

  test("un valor mal escrito falla", () => {
    expect(() => resolveConfig({}, { OPENFACTURA_API_KEY: "k", OPENFACTURA_LIMITE: "rapido" })).toThrow(ConfigError);
  });
});
