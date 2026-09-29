import { type Contexto, UsageError, ValidationError, entero, texto } from "../../command.ts";
import { fecha, hoy } from "../../fechas.ts";
import { normalizarRut } from "../../rut.ts";
import { parsearItem } from "../../dte/items.ts";
import { emisorDesdeOrganizacion, RECEPTOR_CONSUMIDOR_FINAL, receptorDesdeFicha } from "../../dte/partes.ts";
import { type Modo, calcularTotales } from "../../dte/totales.ts";
import { ordenarDte, validarContraEsquema } from "../../dte/esquema.ts";
import {
  DESPACHO,
  FORMA_PAGO,
  MEDIO_PAGO_BOLETA,
  MESES_PLAZO_REBAJA,
  type Obj,
  TIPOS,
  TIPOS_BOLETA,
  TIPOS_EXENTOS,
  TRASLADO,
  UMBRAL_BOLETA_IDENTIFICADA,
  VIGENCIA_RES_154,
  correo,
  detalle,
  lista,
  opcion,
  totalesDte,
} from "./comun.ts";
import { notasPrevias, receptorDeNota, referenciaNota, referenciasLibres, restarMeses, totalesOriginales } from "./referencias.ts";
import { enviar, validarAntesDeEmitir } from "./enviar.ts";

export async function emitirTipo(ctx: Contexto, nombre: string) {
  const tipo = TIPOS[nombre];
  if (!tipo) throw new UsageError(`Tipo "${nombre}" no existe. Usa: ${[...Object.keys(TIPOS), "archivo"].join(", ")}`);
  validarAntesDeEmitir(ctx);
  const avisos: string[] = [];
  const fechaEmision = fecha(texto(ctx.flags, "fecha") ?? hoy(), "fecha");
  if (fechaEmision > hoy()) avisos.push(`La fecha de emisión ${fechaEmision} es futura`);
  const email = correo(ctx);
  const entrada = lista(ctx, "item").map((t, i) => parsearItem(t, i + 1, avisos));

  if (!tipo.nota && (ctx.flags["sin-rebaja"] || texto(ctx.flags, "referencia"))) {
    throw new UsageError("--referencia y --sin-rebaja son sólo para notas de crédito y débito. Para citar una guía u orden de compra usa --ref");
  }
  if (tipo.nota && lista(ctx, "ref").length) throw new UsageError("En una nota el documento corregido va con --referencia, no con --ref");
  if (tipo.boleta && lista(ctx, "ref").length) {
    throw new UsageError("La boleta no lleva --ref: su esquema de referencias es otro. Si hace falta, arma el DTE y emítelo con: openfactura emitir archivo");
  }

  const org = ((await ctx.client.get("/organization")) ?? {}) as Obj;
  const acteco = texto(ctx.flags, "acteco");
  const emisor = emisorDesdeOrganizacion(org, tipo.boleta, acteco ? entero(acteco, "--acteco") : undefined, avisos);
  const rutPropio = normalizarRut(String(emisor.RUTEmisor));

  const ref = tipo.nota ? await referenciaNota(ctx, tipo, rutPropio) : undefined;
  const modo: Modo = ref ? (TIPOS_EXENTOS.has(ref.tipo) ? "exento" : TIPOS_BOLETA.has(ref.tipo) ? "bruto" : "neto") : tipo.modo;
  if (ctx.flags["con-iva"] && modo !== "neto") {
    throw new UsageError(
      "--con-iva es para factura y notas sobre factura. En boleta y en notas sobre boleta el precio ya va con IVA; en documentos exentos no hay IVA",
    );
  }
  const origTotales = ref ? totalesOriginales(ref.original.Encabezado.Totales, modo) : undefined;

  let receptor: Obj;
  let fichaReceptor: Obj | undefined;
  const rutReceptor = texto(ctx.flags, "receptor");
  if (ref) {
    receptor = receptorDeNota(ctx, ref, email);
  } else if (rutReceptor) {
    const rut = normalizarRut(rutReceptor);
    fichaReceptor = ((await ctx.client.get(`/taxpayer/${rut}`)) ?? {}) as Obj;
    const manual = {
      razonSocial: texto(ctx.flags, "razon-social"),
      giro: texto(ctx.flags, "giro"),
      direccion: texto(ctx.flags, "direccion"),
      comuna: texto(ctx.flags, "comuna"),
      contacto: texto(ctx.flags, "contacto"),
      correo: email,
    };
    receptor = receptorDesdeFicha(rut, fichaReceptor, manual, tipo.boleta, avisos);
  } else if (tipo.receptor === "opcional") {
    receptor = { ...RECEPTOR_CONSUMIDOR_FINAL, ...(email ? { CorreoRecep: email } : {}) };
  } else {
    throw new UsageError("Falta --receptor <rut>");
  }

  let det: Obj[];
  let totales: Obj;
  if (ref?.codRef === 1) {
    if (entrada.length) throw new UsageError("--anula deja sin efecto el documento completo y no lleva --item. Para rebajar una parte usa --corrige-montos");
    const t = ref.original.Encabezado.Totales ?? {};
    if (t.ImptoReten || t.OtrosImp || t.MntNF || ref.original.DscRcgGlobal) {
      throw new ValidationError(
        "El documento original trae impuestos adicionales, montos no facturables o descuentos globales que --anula no copia. Arma la nota completa con: openfactura emitir archivo",
      );
    }
    det = ref.original.Detalle;
    if (!Array.isArray(det) || det.length === 0) throw new ValidationError("El documento original no trae detalle para copiar");
    totales = totalesDte(origTotales!, tipo, modo);
  } else if (ref?.codRef === 2) {
    if (entrada.length) throw new UsageError("--corrige-texto no lleva --item: la corrección va en --razon");
    det = [{ NroLinDet: 1, NmbItem: ref.razon, QtyItem: 1, MontoItem: 0, ...(modo === "exento" ? { IndExe: 1 } : {}) }];
    totales = totalesDte({ MntNeto: 0, MntExe: 0, IVA: 0, MntTotal: 0 }, tipo, modo);
  } else {
    if (!ref && entrada.length && entrada.every((l) => l.exento) && (tipo.codigo === 33 || tipo.codigo === 39)) {
      throw new ValidationError(`Todas las líneas son exentas: corresponde ${tipo.codigo === 33 ? "factura-exenta (34)" : "boleta-exenta (41)"}, no ${nombre}`);
    }
    const calculo = calcularTotales(modo, entrada, { preciosConIva: Boolean(ctx.flags["con-iva"]), permitirCero: tipo.guia });
    avisos.push(...calculo.avisos);
    det = detalle(calculo.lineas);
    totales = totalesDte(calculo.totales, tipo, modo);
  }

  if (ref && tipo.codigo === 61 && ref.codRef !== 2) {
    const nombres: Record<string, string> = { MntNeto: "el neto", MntExe: "el monto exento", IVA: "el IVA", MntTotal: "el total" };
    const previas = await notasPrevias(ctx, ref, rutPropio, receptor, avisos);
    const acumulado = (k: string) => (totales[k] ?? 0) + (previas?.suma[k] ?? 0);
    const excesos = ["MntNeto", "MntExe", "IVA", "MntTotal"]
      .filter((k) => acumulado(k) > (origTotales![k] ?? 0))
      .map((k) => `${nombres[k]} (${acumulado(k)} contra ${origTotales![k] ?? 0})`);
    if (excesos.length) {
      const ya = previas?.folios.length ? ` Ya hay notas de crédito contra este documento: ${previas.folios.join(", ")}.` : "";
      throw new ValidationError(`La nota de crédito supera lo que tiene el documento que corrige en ${excesos.join(", ")}.${ya}`);
    }
  }

  if (ref) {
    if (fechaEmision < ref.fecha) throw new ValidationError(`La nota no puede tener fecha (${fechaEmision}) anterior al documento que corrige (${ref.fecha})`);
    if (tipo.codigo === 61 && ref.codRef !== 2 && ref.fecha < restarMeses(fechaEmision, MESES_PLAZO_REBAJA) && !ctx.flags["sin-rebaja"]) {
      avisos.push(
        `El documento es de hace más de ${MESES_PLAZO_REBAJA} meses. Si la nota es por una devolución o resciliación, ya no da derecho a rebajar el IVA (DL 825 art. 21 N° 2): emítela con --sin-rebaja. Un descuento posterior no tiene ese plazo`,
      );
    }
  }

  const idDoc: Obj = { TipoDTE: tipo.codigo, Folio: 0, FchEmis: fechaEmision };
  if (modo === "bruto" && tipo.nota) idDoc.MntBruto = 1;
  if (ctx.flags["sin-rebaja"]) {
    if (tipo.codigo !== 61) throw new UsageError("--sin-rebaja es sólo para notas de crédito");
    idDoc.IndNoRebaja = 1;
  }
  if (tipo.boleta) {
    const ind = texto(ctx.flags, "ind-servicio");
    idDoc.IndServicio = ind ? entero(ind, "--ind-servicio") : 3;
    if ((idDoc.IndServicio === 1 || idDoc.IndServicio === 2) && !rutReceptor) {
      throw new ValidationError("Una boleta de servicio periódico es nominativa: indica el cliente con --receptor (Res. Ex. SII 74/2020)");
    }
    const medio = opcion(MEDIO_PAGO_BOLETA, texto(ctx.flags, "medio-pago"), "medio-pago");
    if (medio !== undefined) idDoc.MedioPago = medio;
    if (totales.MntTotal > UMBRAL_BOLETA_IDENTIFICADA && (!rutReceptor || medio === undefined)) {
      throw new ValidationError(
        "Una boleta sobre 135 UF exige nombre y RUT del comprador y la forma de pago (Res. Ex. SII 44/2025). " +
          `Sobre ${UMBRAL_BOLETA_IDENTIFICADA.toLocaleString("es-CL")} pesos el CLI los pide siempre: agrega --receptor y --medio-pago`,
      );
    }
    if (fichaReceptor && Array.isArray(fichaReceptor.actividades) && fichaReceptor.actividades.some((a: Obj) => a?.giro)) {
      avisos.push("El receptor tiene giro en el SII. Si compra para su negocio, corresponde factura y no boleta (DL 825 art. 53 letra a)");
    }
  } else {
    const forma = opcion(FORMA_PAGO, texto(ctx.flags, "forma-pago"), "forma-pago");
    if (forma !== undefined) idDoc.FmaPago = forma;
  }

  const encabezado: Obj = { IdDoc: idDoc, Emisor: emisor, Receptor: receptor };
  if (tipo.guia) {
    const traslado = opcion(TRASLADO, texto(ctx.flags, "traslado"), "traslado");
    if (traslado === undefined) throw new UsageError(`La guía necesita --traslado: ${Object.keys(TRASLADO).join(", ")}`);
    const despacho = opcion(DESPACHO, texto(ctx.flags, "despacho"), "despacho");
    idDoc.IndTraslado = traslado;
    if (despacho !== undefined) idDoc.TipoDespacho = despacho;
    const transporte: Obj = {};
    const limpio = (n: string) => texto(ctx.flags, n)?.trim() || undefined;
    const placa = (n: string) =>
      limpio(n)
        ?.toUpperCase()
        .replace(/[\s.-]/g, "") || undefined;
    const patente = placa("patente");
    const carro = placa("patente-carro");
    const trans = limpio("transportista-rut");
    const choferRut = limpio("chofer-rut");
    const choferNombre = limpio("chofer-nombre");
    const dir = limpio("destino-direccion");
    const cmna = limpio("destino-comuna");
    if (patente) transporte.Patente = patente;
    if (carro) transporte.PatenteCarro = carro;
    if (trans) transporte.RUTTrans = normalizarRut(trans);
    if (choferRut || choferNombre) {
      transporte.Chofer = { ...(choferRut ? { RUTChofer: normalizarRut(choferRut) } : {}), ...(choferNombre ? { NombreChofer: choferNombre } : {}) };
    }
    if (dir) transporte.DirDest = dir;
    if (cmna) transporte.CmnaDest = cmna;
    const faltan = [
      !dir && "--destino-direccion",
      !cmna && "--destino-comuna",
      !choferRut && "--chofer-rut",
      !choferNombre && "--chofer-nombre",
      !patente && "--patente",
      !trans && "--transportista-rut",
    ].filter(Boolean);
    if (faltan.length) {
      const mensaje = `La Res. Ex. SII 154/2025 exige en las guías origen, destino, chofer, transportista y patente desde el ${VIGENCIA_RES_154}. Falta: ${faltan.join(", ")}`;
      if (fechaEmision >= VIGENCIA_RES_154) throw new ValidationError(mensaje);
      avisos.push(mensaje);
    }
    if (Object.keys(transporte).length) encabezado.Transporte = transporte;
    if (traslado === 1 && totales.MntTotal === 0) avisos.push("Es una guía de venta con monto cero: revisa los precios, o usa otro --traslado si no es venta");
  }
  encabezado.Totales = totales;

  let dte: Obj = { Encabezado: encabezado, Detalle: det };
  if (ref) {
    dte.Referencia = [{ NroLinRef: 1, TpoDocRef: String(ref.tipo), FolioRef: ref.folio, FchRef: ref.fecha, CodRef: ref.codRef, RazonRef: ref.razon }];
  } else {
    const refs = await referenciasLibres(ctx, rutPropio);
    if (refs.length) dte.Referencia = refs;
  }
  dte = ordenarDte(dte, tipo.boleta);
  validarContraEsquema(dte, tipo.boleta);

  const resumen = {
    tipo: tipo.codigo,
    nombre,
    fecha: fechaEmision,
    receptor: receptor.RznSocRecep,
    rutReceptor: receptor.RUTRecep,
    neto: totales.MntNeto,
    exento: totales.MntExe,
    iva: totales.IVA,
    total: totales.MntTotal,
    lineas: det.length,
    ...(ref ? { referencia: `${ref.tipo}:${ref.folio}`, codRef: ref.codRef } : {}),
  };
  return enviar(ctx, dte, { correo: email }, resumen, avisos);
}
