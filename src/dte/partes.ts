import { ValidationError } from "../command.ts";
import { largoMaximo } from "./esquema.ts";

export const MAX_GIRO_RECEPTOR = 40;
export const RECEPTOR_CONSUMIDOR_FINAL = {
  RUTRecep: "66666666-6",
  RznSocRecep: "Cliente",
  DirRecep: "Sin direccion",
  CmnaRecep: "Santiago",
} as const;

type Obj = Record<string, unknown>;

const limpio = (v: unknown) => (typeof v === "string" ? v.replace(/\s{2,}/g, " ").trim() : "");

const NOMBRES: Record<string, string> = {
  RznSoc: "la razón social del emisor",
  RznSocEmisor: "la razón social del emisor",
  GiroEmis: "el giro del emisor",
  GiroEmisor: "el giro del emisor",
  DirOrigen: "la dirección del emisor",
  CmnaOrigen: "la comuna del emisor",
  RznSocRecep: "la razón social del receptor",
  DirRecep: "la dirección del receptor",
  CmnaRecep: "la comuna del receptor",
};

function delSii(campo: string, valor: string, avisos: string[]): string {
  const limite = largoMaximo(campo);
  if (limite === undefined || valor.length <= limite) return valor;
  avisos.push(`El SII trae ${NOMBRES[campo] ?? campo} con ${valor.length} caracteres; se recortó a ${limite}, que es lo que admite el formato del SII`);
  return valor.slice(0, limite).trim();
}

interface Actividad {
  giro?: string | null;
  codigoActividadEconomica?: string | number | null;
  actividadPrincipal?: boolean;
}

function actividades(ficha: Obj): Actividad[] {
  return Array.isArray(ficha.actividades) ? (ficha.actividades as Actividad[]) : [];
}

function principal(ficha: Obj): Actividad | undefined {
  const lista = actividades(ficha).filter((a) => a.giro || a.codigoActividadEconomica);
  return lista.find((a) => a.actividadPrincipal) ?? lista[0];
}

export function emisorDesdeOrganizacion(org: Obj, esBoleta: boolean, acteco?: number, avisos: string[] = []): Obj {
  const rut = limpio(org.rut);
  const razon = delSii(esBoleta ? "RznSocEmisor" : "RznSoc", limpio(org.razonSocial), avisos);
  const giro = delSii(esBoleta ? "GiroEmisor" : "GiroEmis", limpio(org.glosaDescriptiva) || limpio(principal(org)?.giro), avisos);
  const dir = delSii("DirOrigen", limpio(org.direccion), avisos);
  const comuna = delSii("CmnaOrigen", limpio(org.comuna), avisos);
  const faltan = [!rut && "rut", !razon && "razón social", !giro && "giro", !dir && "dirección", !comuna && "comuna"].filter(Boolean);
  if (faltan.length) throw new ValidationError(`OpenFactura no devolvió estos datos del emisor: ${faltan.join(", ")}`);
  const sucursal = limpio(org.cdgSIISucur);

  if (esBoleta) {
    return { RUTEmisor: rut, RznSocEmisor: razon, GiroEmisor: giro, DirOrigen: dir, CmnaOrigen: comuna, ...(sucursal ? { CdgSIISucur: sucursal } : {}) };
  }
  const codigo = acteco ?? Number(principal(org)?.codigoActividadEconomica);
  if (!Number.isInteger(codigo) || codigo <= 0) {
    throw new ValidationError("No se encontró la actividad económica del emisor. Pásala con --acteco <código>");
  }
  return { RUTEmisor: rut, RznSoc: razon, GiroEmis: giro, Acteco: codigo, DirOrigen: dir, CmnaOrigen: comuna, ...(sucursal ? { CdgSIISucur: sucursal } : {}) };
}

export interface DatosReceptor {
  razonSocial?: string;
  giro?: string;
  direccion?: string;
  comuna?: string;
  contacto?: string;
  correo?: string;
}

export function receptorDesdeFicha(rut: string, ficha: Obj, manual: DatosReceptor, esBoleta: boolean, avisos: string[]): Obj {
  const encontrado = Boolean(ficha.razonSocial || ficha.direccion);
  const razon = manual.razonSocial ?? delSii("RznSocRecep", limpio(ficha.razonSocial), avisos);
  const direccion = manual.direccion ?? delSii("DirRecep", limpio(ficha.direccion), avisos);
  const comuna = manual.comuna ?? delSii("CmnaRecep", limpio(ficha.comuna), avisos);

  if (!razon) {
    throw new ValidationError(
      encontrado
        ? `El SII no trae razón social para ${rut}. Pásala con --razon-social`
        : `El SII no conoce el RUT ${rut}. Revisa el RUT o pasa los datos a mano con --razon-social, --direccion y --comuna`,
    );
  }

  const receptor: Obj = { RUTRecep: rut, RznSocRecep: razon };
  if (!esBoleta) {
    let giro = manual.giro ?? limpio(principal(ficha)?.giro);
    if (!giro) {
      throw new ValidationError(
        `${razon} (${rut}) no tiene giro en el SII, así que no puede recibir factura: emítele una boleta. Si sabes que sí tiene giro, pásalo con --giro`,
      );
    }
    if (giro.length > MAX_GIRO_RECEPTOR) {
      avisos.push(`El giro del receptor se recortó a ${MAX_GIRO_RECEPTOR} caracteres, que es lo que admite el SII`);
      giro = giro.slice(0, MAX_GIRO_RECEPTOR).trimEnd();
    }
    receptor.GiroRecep = giro;
    if (manual.contacto) receptor.Contacto = manual.contacto;
  }
  if (!direccion || !comuna) throw new ValidationError(`Faltan la dirección o la comuna de ${razon}. Pásalas con --direccion y --comuna`);
  receptor.DirRecep = direccion;
  receptor.CmnaRecep = comuna;
  if (manual.correo) receptor.CorreoRecep = manual.correo;
  return receptor;
}
