import { type Comando, UsageError, arg } from "../../command.ts";
import { VIGENCIA_RES_154 } from "./comun.ts";
import { emitirTipo } from "./tipo.ts";
import { emitirArchivo } from "./archivo.ts";

export const USO = `openfactura emitir <tipo> [opciones]
openfactura emitir archivo <dte.json> [--confirmar]

Tipos: factura (33), factura-exenta (34), boleta (39), boleta-exenta (41),
       nota-credito (61), nota-debito (56), guia (52).
Cualquier otro tipo (43 liquidación-factura, 46 factura de compra, exportación) va con "archivo".

EN SECO POR DEFECTO. Sin --confirmar arma el DTE, calcula los totales y lo muestra sin emitir.
Emitir es irreversible: un error se corrige con nota de crédito, no borrando.

Ítems (repetible):
  --item "nombre|cantidad|precio"          Precio unitario, sin separador de miles (69000, no 69.000).
                                           Neto en factura y notas; con IVA en boleta y en notas sobre boleta
  --item "nombre|cantidad|precio|exento"   Línea exenta de IVA. Sólo si la ley la declara exenta
  --item '{"nombre":"..","cantidad":1,"precio":1000,"exento":false,"descripcion":".."}'
  --con-iva        En factura, los precios vienen con IVA y se desglosan

Receptor:
  --receptor <rut>   Se completa con la ficha del SII. Obligatorio salvo en boletas y notas
  --razon-social, --giro, --direccion, --comuna, --contacto   Reemplazan lo que traiga el SII
  --correo <email>   Correo del receptor. OpenFactura le manda el documento cuando el SII lo acepta

Documento:
  --fecha AAAA-MM-DD          Fecha de emisión (default: hoy en Chile)
  --forma-pago contado|credito|sin-costo          (factura, notas, guía)
  --medio-pago efectivo|electronico|transferencia|cheque|otro   (boleta)
  --ind-servicio <n>          Boleta: 3 venta y servicios (default); 1 y 2 servicios periódicos (nominativa)
  --acteco <código>           Actividad económica del emisor, si no es la principal
  --ref <tipo>:<folio>[:fecha]  Documento que se cita (repetible): 52 guía, 801 orden de compra, etc.
                              Para una guía propia la fecha se busca sola

Notas de crédito y débito:
  --referencia <tipo>:<folio>   Documento que se corrige, ej. 33:30. Receptor y fecha salen de ahí
  --anula                       Anula el documento completo, copiando su detalle. No lleva --item
  --corrige-montos              Rebaja (crédito) o aumenta (débito) por los --item que indiques
  --corrige-texto               Corrige un dato sin tocar montos. Va con --razon
  --razon "<texto>"             Motivo que queda en la referencia
  --sin-rebaja                  Nota de crédito que no rebaja el IVA (devolución fuera de plazo)
  El receptor es siempre el del original. Un RUT equivocado se corrige anulando y reemitiendo.

Guía de despacho:
  --traslado venta|venta-por-efectuar|consignacion|entrega-gratuita|interno|otro-traslado|
             devolucion|traslado-exportacion|venta-exportacion
  --despacho receptor|emisor-cliente|emisor-otro
  --destino-direccion, --destino-comuna
  --chofer-rut, --chofer-nombre, --transportista-rut, --patente, --patente-carro
  Desde el ${VIGENCIA_RES_154} la Res. Ex. SII 154/2025 hace obligatorios destino, chofer, transportista y patente.

Envío:
  --confirmar             Emite de verdad ante el SII
  --pdf <archivo>         Guarda el PDF que devuelve la emisión
  --esperar <segundos>    Espera a que el SII responda Aceptado o Rechazado
  --intervalo <segundos>  Cada cuánto consulta mientras espera (default 10, mínimo 1)
  --idempotency-key <k>   Por defecto es el sha256 del DTE: repetir el mismo comando no emite dos veces.
                          Para dos ventas idénticas el mismo día (dos boletas iguales), pasa una clave distinta`;

export const EMISION: Comando[] = [
  {
    nombre: "emitir",
    minArgs: 1,
    maxArgs: 2,
    resumen: "Emite factura, boleta, notas, guía o un DTE desde archivo (en seco sin --confirmar)",
    uso: USO,
    flags: {
      item: { type: "string", multiple: true },
      "con-iva": { type: "boolean" },
      receptor: { type: "string" },
      "razon-social": { type: "string" },
      giro: { type: "string" },
      direccion: { type: "string" },
      comuna: { type: "string" },
      contacto: { type: "string" },
      correo: { type: "string" },
      fecha: { type: "string" },
      "forma-pago": { type: "string" },
      "medio-pago": { type: "string" },
      "ind-servicio": { type: "string" },
      acteco: { type: "string" },
      ref: { type: "string", multiple: true },
      referencia: { type: "string" },
      anula: { type: "boolean" },
      "corrige-montos": { type: "boolean" },
      "corrige-texto": { type: "boolean" },
      razon: { type: "string" },
      "sin-rebaja": { type: "boolean" },
      traslado: { type: "string" },
      despacho: { type: "string" },
      "destino-direccion": { type: "string" },
      "destino-comuna": { type: "string" },
      "chofer-rut": { type: "string" },
      "chofer-nombre": { type: "string" },
      "transportista-rut": { type: "string" },
      patente: { type: "string" },
      "patente-carro": { type: "string" },
      confirmar: { type: "boolean" },
      pdf: { type: "string" },
      sobrescribir: { type: "boolean" },
      esperar: { type: "string" },
      intervalo: { type: "string" },
      "idempotency-key": { type: "string" },
    },
    run: (ctx) => {
      const tipo = arg(ctx, 0, "tipo");
      if (tipo !== "archivo" && ctx.args.length > 1) throw new UsageError(`Sobran argumentos: ${ctx.args.slice(1).join(" ")}`);
      return tipo === "archivo" ? emitirArchivo(ctx) : emitirTipo(ctx, tipo);
    },
  },
];
