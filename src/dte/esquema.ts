import { ValidationError } from "../command.ts";

type Obj = Record<string, any>;

const ORDEN_DTE: Record<string, string[]> = {
  Documento: ["Encabezado", "Detalle", "SubTotInfo", "DscRcgGlobal", "Referencia", "GeoRefEmision", "ManejoMadera", "Comisiones"],
  Encabezado: ["IdDoc", "Emisor", "RUTMandante", "Receptor", "RUTSolicita", "Transporte", "Totales", "OtraMoneda"],
  IdDoc: [
    "TipoDTE",
    "Folio",
    "FchEmis",
    "IndNoRebaja",
    "TipoDespacho",
    "IndTraslado",
    "TpoImpresion",
    "IndServicio",
    "MntBruto",
    "TpoTranCompra",
    "TpoTranVenta",
    "FmaPago",
    "FmaPagExp",
    "FchCancel",
    "MntCancel",
    "SaldoInsol",
    "MntPagos",
    "PeriodoDesde",
    "PeriodoHasta",
    "MedioPago",
    "TpoCtaPago",
    "NumCtaPago",
    "BcoPago",
    "TermPagoCdg",
    "TermPagoGlosa",
    "TermPagoDias",
    "FchVenc",
    "TipoFactEsp",
  ],
  Emisor: [
    "RUTEmisor",
    "RznSoc",
    "GiroEmis",
    "Telefono",
    "CorreoEmisor",
    "Acteco",
    "GuiaExport",
    "Sucursal",
    "CdgSIISucur",
    "DirOrigen",
    "CmnaOrigen",
    "CiudadOrigen",
    "CdgVendedor",
    "IdAdicEmisor",
    "RUTProveedor",
    "RznSocProveedor",
  ],
  Receptor: [
    "RUTRecep",
    "CdgIntRecep",
    "RznSocRecep",
    "Extranjero",
    "GiroRecep",
    "Contacto",
    "CorreoRecep",
    "DirRecep",
    "CmnaRecep",
    "CiudadRecep",
    "DirPostal",
    "CmnaPostal",
    "CiudadPostal",
  ],
  Transporte: ["Patente", "PatenteCarro", "RUTTrans", "Chofer", "DirDest", "CmnaDest", "CiudadDest", "Aduana", "FchSalida", "HraSalida", "FchLlegada"],
  Chofer: ["RUTChofer", "NombreChofer"],
  Totales: [
    "MntNeto",
    "MntExe",
    "MntBase",
    "MntMargenCom",
    "TasaIVA",
    "IVA",
    "IVAProp",
    "IVATerc",
    "ImptoReten",
    "IVANoRet",
    "CredEC",
    "GrntDep",
    "Comisiones",
    "MntTotal",
    "MontoNF",
    "MontoPeriodo",
    "SaldoAnterior",
    "VlrPagar",
  ],
  Detalle: [
    "NroLinDet",
    "CdgItem",
    "IndExe",
    "Retenedor",
    "NmbItem",
    "DscItem",
    "QtyRef",
    "UnmdRef",
    "PrcRef",
    "QtyItem",
    "Subcantidad",
    "FchElabor",
    "FchVencim",
    "UnmdItem",
    "PrcItem",
    "OtrMnda",
    "DescuentoPct",
    "DescuentoMonto",
    "SubDscto",
    "RecargoPct",
    "RecargoMonto",
    "SubRecargo",
    "CodImpAdic",
    "MontoItem",
  ],
  Referencia: ["NroLinRef", "TpoDocRef", "IndGlobal", "FolioRef", "RUTOtr", "FchRef", "CodRef", "RazonRef"],
};

const ORDEN_BOLETA: Record<string, string[]> = {
  Documento: ["Encabezado", "Detalle", "SubTotInfo", "DscRcgGlobal", "Referencia", "GeoRefEmision"],
  Encabezado: ["IdDoc", "Emisor", "Receptor", "RUTProvSW", "Totales"],
  IdDoc: ["TipoDTE", "Folio", "FchEmis", "IndServicio", "IndMntNeto", "PeriodoDesde", "PeriodoHasta", "FchVenc", "MedioPago"],
  Emisor: ["RUTEmisor", "RznSocEmisor", "GiroEmisor", "CdgSIISucur", "DirOrigen", "CmnaOrigen", "CiudadOrigen"],
  Receptor: [
    "RUTRecep",
    "CdgIntRecep",
    "RznSocRecep",
    "Contacto",
    "CorreoRecep",
    "TelefonoRecep",
    "DirRecep",
    "CmnaRecep",
    "CiudadRecep",
    "DirPostal",
    "CmnaPostal",
    "CiudadPostal",
  ],
  Totales: ["MntNeto", "MntExe", "IVA", "MntTotal", "MontoNF", "TotalPeriodo", "SaldoAnterior", "VlrPagar"],
  Detalle: [
    "NroLinDet",
    "CdgItem",
    "IndExe",
    "ItemEspectaculo",
    "RUTMandante",
    "NmbItem",
    "InfoTicket",
    "DscItem",
    "QtyItem",
    "UnmdItem",
    "PrcItem",
    "DescuentoPct",
    "DescuentoMonto",
    "RecargoPct",
    "RecargoMonto",
    "MontoItem",
  ],
  Referencia: ["NroLinRef", "TpoDocRef", "FolioRef", "CodRef", "RazonRef", "CodVndor", "CodCaja"],
};

export const LARGOS = {
  RznSoc: 100,
  RznSocEmisor: 100,
  GiroEmis: 80,
  GiroEmisor: 80,
  DirOrigen: 70,
  CmnaOrigen: 20,
  RznSocRecep: 100,
  GiroRecep: 40,
  Contacto: 80,
  CorreoRecep: 80,
  DirRecep: 70,
  CmnaRecep: 20,
  NmbItem: 80,
  DscItem: 1000,
  RazonRef: 90,
  FolioRef: 18,
  Patente: 8,
  PatenteCarro: 8,
  NombreChofer: 30,
  DirDest: 70,
  CmnaDest: 20,
} satisfies Record<string, number>;

export function largoMaximo(campo: string): number | undefined {
  return (LARGOS as Record<string, number>)[campo];
}

const MAX_LINEAS = { dte: 60, boleta: 1000 };
const MAX_REFERENCIAS = 40;

function ordenar(valor: unknown, seccion: string, orden: Record<string, string[]>): unknown {
  if (Array.isArray(valor)) return valor.map((v) => ordenar(v, seccion, orden));
  const claves = orden[seccion];
  if (!claves || !valor || typeof valor !== "object") return valor;
  const o = valor as Obj;
  const conocidas = claves.filter((k) => k in o);
  const otras = Object.keys(o).filter((k) => !claves.includes(k));
  const salida: Obj = {};
  for (const k of [...conocidas, ...otras]) salida[k] = orden[k] ? ordenar(o[k], k, orden) : o[k];
  return salida;
}

export function ordenarDte<T extends Obj>(dte: T, esBoleta: boolean): T {
  return ordenar(dte, "Documento", esBoleta ? ORDEN_BOLETA : ORDEN_DTE) as T;
}

function revisarLargos(valor: unknown, ruta: string, errores: string[]) {
  if (Array.isArray(valor)) {
    for (const [i, v] of valor.entries()) revisarLargos(v, `${ruta}[${i + 1}]`, errores);
    return;
  }
  if (!valor || typeof valor !== "object") return;
  for (const [k, v] of Object.entries(valor as Obj)) {
    const limite = largoMaximo(k);
    if (limite !== undefined && typeof v === "string" && v.length > limite) {
      errores.push(`${ruta}.${k} tiene ${v.length} caracteres y el SII admite ${limite}`);
    } else if (limite !== undefined && typeof v === "number" && String(v).length > limite) {
      errores.push(`${ruta}.${k} tiene ${String(v).length} dígitos y el SII admite ${limite}`);
    }
    revisarLargos(v, `${ruta}.${k}`, errores);
  }
}

export function validarContraEsquema(dte: Obj, esBoleta: boolean): void {
  const errores: string[] = [];
  const maxLineas = esBoleta ? MAX_LINEAS.boleta : MAX_LINEAS.dte;
  if (Array.isArray(dte.Detalle) && dte.Detalle.length > maxLineas) {
    errores.push(`El documento tiene ${dte.Detalle.length} líneas de detalle y el SII admite ${maxLineas}`);
  }
  if (Array.isArray(dte.Referencia) && dte.Referencia.length > MAX_REFERENCIAS) {
    errores.push(`El documento tiene ${dte.Referencia.length} referencias y el SII admite ${MAX_REFERENCIAS}`);
  }
  revisarLargos(dte, "dte", errores);
  if (errores.length) throw new ValidationError(`El documento no cumple el formato del SII: ${errores.join("; ")}`, errores);
}
