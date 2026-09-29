import { describe, expect, test } from "bun:test";
import { calcularTotales, type Linea } from "../src/dte/totales.ts";

const linea = (precio: number, extra: Partial<Linea> = {}): Linea => ({ nombre: "x", cantidad: 1, precio, exento: false, ...extra });

describe("factura (detalle neto)", () => {
  test("neto 69.000 da IVA 13.110 y total 82.110", () => {
    const t = calcularTotales("neto", [linea(69000)]);
    expect(t.totales).toEqual({ MntNeto: 69000, IVA: 13110, MntTotal: 82110 });
    expect(t.lineas[0]!.monto).toBe(69000);
  });

  test("la nota de crédito de 74.500 neto da 88.655", () => {
    expect(calcularTotales("neto", [linea(74500)]).totales).toEqual({ MntNeto: 74500, IVA: 14155, MntTotal: 88655 });
  });

  test("cantidad por precio se redondea por línea", () => {
    const t = calcularTotales("neto", [linea(1000.5, { cantidad: 3 })]);
    expect(t.lineas[0]!.monto).toBe(3002);
    expect(t.totales.MntNeto).toBe(3002);
  });

  test("una línea exenta suma a MntExe y no paga IVA", () => {
    const t = calcularTotales("neto", [linea(1000), linea(500, { exento: true })]);
    expect(t.totales).toEqual({ MntNeto: 1000, MntExe: 500, IVA: 190, MntTotal: 1690 });
  });

  test("con precios con IVA, 177.310 se desglosa en 149.000 + 28.310", () => {
    const t = calcularTotales("neto", [linea(177310)], { preciosConIva: true });
    expect(t.totales).toEqual({ MntNeto: 149000, IVA: 28310, MntTotal: 177310 });
    expect(t.lineas[0]!.precio).toBe(149000);
  });

  test("con precios con IVA el precio neto conserva decimales para que el total calce", () => {
    const t = calcularTotales("neto", [linea(1000, { cantidad: 3 })], { preciosConIva: true });
    expect(t.lineas[0]!.precio).toBe(840.336134);
    expect(t.totales).toEqual({ MntNeto: 2521, IVA: 479, MntTotal: 3000 });
    expect(t.avisos).toEqual([]);
  });
});

describe("boleta (detalle bruto)", () => {
  test("48.732 bruto da neto 40.951 e IVA 7.781, como la boleta aceptada", () => {
    expect(calcularTotales("bruto", [linea(48732)]).totales).toEqual({ MntNeto: 40951, IVA: 7781, MntTotal: 48732 });
  });

  test("24.376 bruto da neto 20.484 e IVA 3.892, como la boleta aceptada", () => {
    expect(calcularTotales("bruto", [linea(24376)]).totales).toEqual({ MntNeto: 20484, IVA: 3892, MntTotal: 24376 });
  });

  test("una línea exenta en boleta queda fuera del desglose de IVA", () => {
    expect(calcularTotales("bruto", [linea(11900), linea(1000, { exento: true })]).totales).toEqual({
      MntNeto: 10000,
      MntExe: 1000,
      IVA: 1900,
      MntTotal: 12900,
    });
  });
});

describe("exentos", () => {
  test("un documento exento sólo lleva MntExe y MntTotal", () => {
    expect(calcularTotales("exento", [linea(5000), linea(2000)]).totales).toEqual({ MntExe: 7000, MntTotal: 7000 });
  });

  test("en un documento exento todas las líneas quedan exentas", () => {
    expect(calcularTotales("exento", [linea(5000)]).lineas[0]!.exento).toBe(true);
  });
});

describe("validaciones", () => {
  test("sin líneas falla", () => {
    expect(() => calcularTotales("neto", [])).toThrow(/línea/);
  });

  test("cantidad cero o negativa falla", () => {
    expect(() => calcularTotales("neto", [linea(100, { cantidad: 0 })])).toThrow(/cantidad/);
  });

  test("precio negativo falla", () => {
    expect(() => calcularTotales("neto", [linea(-1)])).toThrow(/precio/);
  });

  test("un total en cero falla salvo que se permita", () => {
    expect(() => calcularTotales("neto", [linea(0)])).toThrow(/cero/);
    expect(calcularTotales("neto", [linea(0)], { permitirCero: true }).totales.MntTotal).toBe(0);
  });
});
