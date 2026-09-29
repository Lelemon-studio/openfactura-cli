import { readFileSync } from "node:fs";
import { type Contexto, UsageError, ValidationError, arg } from "../../command.ts";
import { CORREO, type Obj, correo } from "./comun.ts";
import { enviar } from "./enviar.ts";

export async function emitirArchivo(ctx: Contexto) {
  const ruta = arg(ctx, 1, "archivo.json");
  let contenido: Obj;
  try {
    contenido = JSON.parse(readFileSync(ruta, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    throw new UsageError(`No se pudo leer ${ruta} como JSON: ${(e as Error).message}`);
  }
  if (!contenido || typeof contenido !== "object" || Array.isArray(contenido)) throw new ValidationError("El archivo debe tener un objeto JSON con el DTE");
  const esBody = "dte" in contenido;
  const dte: Obj = esBody ? contenido.dte : contenido;
  const idDoc = dte?.Encabezado?.IdDoc;
  if (!idDoc || !Number.isInteger(Number(idDoc.TipoDTE))) throw new ValidationError("El DTE no trae Encabezado.IdDoc.TipoDTE");
  if (idDoc.Folio !== undefined && Number(idDoc.Folio) !== 0) {
    throw new ValidationError("IdDoc.Folio debe ser 0: el folio lo asigna OpenFactura al emitir");
  }
  const email = correo(ctx);
  const correoArchivo = esBody ? contenido.sendEmail?.to : undefined;
  if (
    correoArchivo !== undefined &&
    !String(correoArchivo)
      .split(",")
      .every((c) => CORREO.test(c.trim()))
  ) {
    throw new ValidationError(`sendEmail.to del archivo no es un correo válido: "${correoArchivo}"`);
  }
  const respuesta = esBody && Array.isArray(contenido.response) ? contenido.response : undefined;
  const resumen = { tipo: Number(idDoc.TipoDTE), archivo: ruta, receptor: dte.Encabezado?.Receptor?.RznSocRecep, total: dte.Encabezado?.Totales?.MntTotal };
  return enviar(ctx, dte, { respuesta, correo: email ?? correoArchivo }, resumen, []);
}
