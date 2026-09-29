import { describe, expect, test } from "bun:test";
import { normalizarRut, rutCuerpo, digitoVerificador } from "../src/rut.ts";

describe("rut", () => {
  test("calcula el dígito verificador, incluida la K y el 0", () => {
    expect(digitoVerificador("76795561")).toBe("8");
    expect(digitoVerificador("11111111")).toBe("1");
    expect(digitoVerificador("66666666")).toBe("6");
    expect(digitoVerificador("10000013")).toBe("K");
    expect(digitoVerificador("76430498")).toBe("5");
  });

  test("normaliza puntos, espacios y k minúscula", () => {
    expect(normalizarRut(" 76.795.561-8 ")).toBe("76795561-8");
    expect(normalizarRut("10000013-k")).toBe("10000013-K");
    expect(normalizarRut("767955618")).toBe("76795561-8");
  });

  test("rechaza un dígito verificador incorrecto", () => {
    expect(() => normalizarRut("76795561-9")).toThrow(/verificador/);
  });

  test("rechaza lo que no es un RUT", () => {
    expect(() => normalizarRut("abc")).toThrow();
    expect(() => normalizarRut("")).toThrow();
  });

  test("rutCuerpo devuelve el número sin dígito, como lo piden los filtros", () => {
    expect(rutCuerpo("76.795.561-8")).toBe(76795561);
  });
});
