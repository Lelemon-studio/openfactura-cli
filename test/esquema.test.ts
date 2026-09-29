import { describe, expect, test } from "bun:test";
import { ordenarDte, validarContraEsquema } from "../src/dte/esquema.ts";

const claves = (o: object) => Object.keys(o);

describe("orden del XSD del SII", () => {
  test("ordena el emisor, el receptor y el detalle de un DTE", () => {
    const dte = ordenarDte(
      {
        Detalle: [{ NroLinDet: 1, NmbItem: "x", QtyItem: 1, PrcItem: 1, MontoItem: 1, IndExe: 1 }],
        Encabezado: {
          Totales: { MntTotal: 1, MntExe: 1 },
          Receptor: { RUTRecep: "1-9", RznSocRecep: "R", DirRecep: "D", CmnaRecep: "C", CorreoRecep: "a@b.cl" },
          Emisor: { RUTEmisor: "1-9", RznSoc: "E", GiroEmis: "G", Acteco: 1, DirOrigen: "D", CmnaOrigen: "C", CdgSIISucur: "1" },
          IdDoc: { TipoDTE: 34, FchEmis: "2026-01-01", Folio: 0 },
        },
      },
      false,
    );
    expect(claves(dte)).toEqual(["Encabezado", "Detalle"]);
    expect(claves(dte.Encabezado)).toEqual(["IdDoc", "Emisor", "Receptor", "Totales"]);
    expect(claves(dte.Encabezado.IdDoc)).toEqual(["TipoDTE", "Folio", "FchEmis"]);
    expect(claves(dte.Encabezado.Emisor)).toEqual(["RUTEmisor", "RznSoc", "GiroEmis", "Acteco", "CdgSIISucur", "DirOrigen", "CmnaOrigen"]);
    expect(claves(dte.Encabezado.Receptor)).toEqual(["RUTRecep", "RznSocRecep", "CorreoRecep", "DirRecep", "CmnaRecep"]);
    expect(claves(dte.Encabezado.Totales)).toEqual(["MntExe", "MntTotal"]);
    expect(claves(dte.Detalle[0]!)).toEqual(["NroLinDet", "IndExe", "NmbItem", "QtyItem", "PrcItem", "MontoItem"]);
  });

  test("usa el orden de la boleta cuando es boleta", () => {
    const dte = ordenarDte({ Encabezado: { IdDoc: { MedioPago: 3, IndServicio: 3, TipoDTE: 39 } }, Detalle: [] }, true);
    expect(claves(dte.Encabezado.IdDoc)).toEqual(["TipoDTE", "IndServicio", "MedioPago"]);
  });

  test("ordena el transporte y el chofer de la guía", () => {
    const dte = ordenarDte(
      { Encabezado: { Transporte: { CmnaDest: "C", Chofer: { NombreChofer: "N", RUTChofer: "1-9" }, Patente: "P", RUTTrans: "1-9" } } },
      false,
    );
    expect(claves(dte.Encabezado.Transporte)).toEqual(["Patente", "RUTTrans", "Chofer", "CmnaDest"]);
    expect(claves(dte.Encabezado.Transporte.Chofer)).toEqual(["RUTChofer", "NombreChofer"]);
  });

  test("una clave que el XSD no conoce queda al final, para que el validador la acuse", () => {
    const dte = ordenarDte({ Encabezado: { Receptor: { Inventado: 1, RUTRecep: "1-9" } } }, false);
    expect(claves(dte.Encabezado.Receptor)).toEqual(["RUTRecep", "Inventado"]);
  });
});

describe("largos y cantidades del XSD", () => {
  const base = (receptor: object = {}, detalle: object[] = [{ NmbItem: "x" }], extra: object = {}) => ({
    Encabezado: {
      Emisor: { RznSoc: "E", GiroEmis: "G", DirOrigen: "D", CmnaOrigen: "C" },
      Receptor: { RznSocRecep: "R", DirRecep: "D", CmnaRecep: "C", ...receptor },
    },
    Detalle: detalle,
    ...extra,
  });

  test("un DTE dentro de los límites pasa", () => {
    expect(() => validarContraEsquema(base(), false)).not.toThrow();
  });

  test("una comuna de más de 20 caracteres falla con el campo y el límite", () => {
    expect(() => validarContraEsquema(base({ CmnaRecep: "x".repeat(21) }), false)).toThrow(/CmnaRecep.*20/);
  });

  test("una dirección de más de 70 falla", () => {
    expect(() => validarContraEsquema(base({ DirRecep: "x".repeat(71) }), false)).toThrow(/DirRecep/);
  });

  test("una descripción de más de 1000 falla", () => {
    expect(() => validarContraEsquema(base({}, [{ NmbItem: "x", DscItem: "x".repeat(1001) }]), false)).toThrow(/DscItem/);
  });

  test("más de 60 líneas en un DTE falla, pero en boleta caben 1000", () => {
    const lineas = Array.from({ length: 61 }, () => ({ NmbItem: "x" }));
    expect(() => validarContraEsquema(base({}, lineas), false)).toThrow(/60/);
    expect(() => validarContraEsquema(base({}, lineas), true)).not.toThrow();
  });

  test("más de 40 referencias falla", () => {
    const refs = Array.from({ length: 41 }, () => ({ FolioRef: 1 }));
    expect(() => validarContraEsquema(base({}, [{ NmbItem: "x" }], { Referencia: refs }), false)).toThrow(/40/);
  });

  test("un nombre de chofer de más de 30 falla", () => {
    const dte = base();
    (dte.Encabezado as any).Transporte = { Chofer: { NombreChofer: "x".repeat(31) } };
    expect(() => validarContraEsquema(dte, false)).toThrow(/NombreChofer/);
  });
});
