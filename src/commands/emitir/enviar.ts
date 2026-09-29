import { createHash } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ApiError } from "../../client.ts";
import { type Contexto, UsageError, entero, texto } from "../../command.ts";
import { MAX_ESPERA_S, type Obj } from "./comun.ts";

export function validarAntesDeEmitir(ctx: Contexto) {
  const clave = texto(ctx.flags, "idempotency-key");
  if (clave !== undefined && clave.trim() === "") throw new UsageError("--idempotency-key no puede ir vacía");
  const espera = texto(ctx.flags, "esperar");
  if (espera !== undefined && entero(espera, "--esperar") > MAX_ESPERA_S) throw new UsageError(`--esperar es de hasta ${MAX_ESPERA_S} segundos`);
  const intervalo = texto(ctx.flags, "intervalo");
  if (intervalo !== undefined) {
    const n = entero(intervalo, "--intervalo");
    if (n < 1 || n > MAX_ESPERA_S) throw new UsageError(`--intervalo va de 1 a ${MAX_ESPERA_S} segundos`);
  }
  const pdf = texto(ctx.flags, "pdf");
  if (pdf !== undefined && pdf.trim() === "") throw new UsageError("--pdf necesita el nombre del archivo");
  if (pdf) {
    if (existsSync(pdf) && !ctx.flags.sobrescribir) throw new UsageError(`Ya existe ${pdf}. Usa otro nombre o --sobrescribir`);
    const carpeta = dirname(resolve(pdf));
    if (!existsSync(carpeta) || !statSync(carpeta).isDirectory()) throw new UsageError(`No existe la carpeta ${carpeta} para guardar el PDF`);
  }
}

export function idempotencia(dte: Obj, dada: string | undefined): string {
  const contenido = JSON.stringify(dte);
  const base = dada?.trim() ? `${dada.trim()}\n${contenido}` : contenido;
  return createHash("sha256").update(base).digest("hex");
}

export function tokenDe(detalles: unknown): string | null {
  if (!Array.isArray(detalles)) return null;
  const t = detalles.find((d) => d && typeof d === "object" && (d as Obj).field === "token");
  return t ? String((t as Obj).issue) : null;
}

export async function enviar(ctx: Contexto, dte: Obj, extra: { respuesta?: string[]; correo?: string }, resumen: Obj, avisos: string[]) {
  validarAntesDeEmitir(ctx);
  const key = idempotencia(dte, texto(ctx.flags, "idempotency-key"));
  const ambiente = ctx.config.env;
  if (!ctx.flags.confirmar) {
    return {
      enSeco: true,
      ambiente,
      resumen,
      avisos,
      idempotencyKey: key,
      dte,
      aviso: `No se emitió nada. Revisa el resumen y el DTE, y repite el comando con --confirmar para emitirlo ante el SII${ambiente === "dev" ? " (ambiente de pruebas)" : ""}.`,
    };
  }

  const pdf = texto(ctx.flags, "pdf");
  const respuesta = [...(extra.respuesta ?? ["FOLIO"])];
  if (pdf && !respuesta.includes("PDF")) respuesta.push("PDF");
  const body: Obj = { response: respuesta, dte };
  if (extra.correo) body.sendEmail = { to: extra.correo };

  let r: unknown;
  try {
    r = await ctx.client.post("/document", body, { idempotencyKey: key });
  } catch (e) {
    if (e instanceof ApiError && e.code === "TIMEOUT") {
      const fechaDte = dte.Encabezado?.IdDoc?.FchEmis;
      throw new ApiError(
        `${e.message}. Para repetirlo exactamente igual aunque cambie el día, agrega --fecha ${fechaDte}` +
          (texto(ctx.flags, "idempotency-key") ? "" : " y usa el mismo comando"),
        0,
        "TIMEOUT",
        { idempotencyKey: key, fecha: fechaDte },
      );
    }
    if (e instanceof ApiError && e.code === "OF-06") {
      const token = tokenDe(e.details);
      return {
        emitido: false,
        yaEmitido: true,
        ambiente,
        token,
        mensaje: e.message,
        aviso:
          "Este mismo documento ya se había enviado (idempotencia). No se emitió uno nuevo. " +
          (token ? `Consulta el existente con: openfactura documento estado --token ${token}` : "Busca el existente con: openfactura emitidos"),
      };
    }
    throw e;
  }

  if (!r || typeof r !== "object" || Array.isArray(r) || typeof (r as Obj).TOKEN !== "string") {
    throw new ApiError(
      "OpenFactura respondió algo que no es una emisión y no se sabe si el documento se emitió. Repite exactamente el mismo comando: la idempotencia evita emitirlo dos veces",
      0,
      "INVALID_RESPONSE",
      { idempotencyKey: key, fecha: dte.Encabezado?.IdDoc?.FchEmis },
    );
  }
  const res = r as Obj;
  const salida: Obj = {
    emitido: true,
    ambiente,
    tipo: dte.Encabezado?.IdDoc?.TipoDTE,
    folio: res.FOLIO ?? null,
    token: res.TOKEN,
    total: dte.Encabezado?.Totales?.MntTotal,
    avisos,
    siguiente: `Consulta si el SII lo aceptó con: openfactura documento estado --token ${res.TOKEN}`,
  };

  try {
    if (res.WARNING) avisos.push(`OpenFactura avisó: ${typeof res.WARNING === "string" ? res.WARNING : JSON.stringify(res.WARNING)}`);
    if (pdf) {
      const bytes = typeof res.PDF === "string" ? Buffer.from(res.PDF, "base64") : Buffer.alloc(0);
      if (bytes.subarray(0, 4).toString("latin1") === "%PDF") {
        writeFileSync(pdf, bytes);
        salida.pdf = { archivo: pdf, bytes: bytes.length };
      } else {
        avisos.push(`El documento se emitió, pero el PDF no llegó bien. Pídelo con: openfactura documento pdf --token ${res.TOKEN}`);
      }
    }
  } catch (e) {
    avisos.push(`El documento se emitió, pero no se pudo guardar el PDF: ${(e as Error).message}`);
  }

  const espera = texto(ctx.flags, "esperar");
  if (espera !== undefined) {
    try {
      salida.estado = await esperarEstado(ctx, res.TOKEN, entero(espera, "--esperar"));
    } catch (e) {
      avisos.push(
        `El documento se emitió, pero no se pudo consultar su estado: ${(e as Error).message}. Reintenta con: openfactura documento estado --token ${res.TOKEN}`,
      );
    }
  }
  return salida;
}

export async function esperarEstado(ctx: Contexto, token: string, segundos: number): Promise<string> {
  const intervalo = texto(ctx.flags, "intervalo") !== undefined ? entero(texto(ctx.flags, "intervalo"), "--intervalo") : 10;
  const limite = Date.now() + segundos * 1000;
  let estado = "Sin estado";
  for (;;) {
    const r = (await ctx.client.get(`/document/${token}/status`)) as Obj | null;
    estado = String(r?.estado ?? estado);
    if (!["Sin estado", "Pendiente"].includes(estado) || Date.now() >= limite) return estado;
    await new Promise((res) => setTimeout(res, intervalo * 1000));
  }
}
