import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli.ts";

const BASE = "https://api.haulmer.com/v2/dte";
const ORG = {
  rut: "76795561-8",
  razonSocial: "HAULMER CHILE SPA",
  direccion: "A PRAT 545 DP 2",
  comuna: "Curicó",
  cdgSIISucur: "81303347",
  glosaDescriptiva: "PRODUCTOS Y SERVICIOS RELACIONADOS CON INTERNET, SOFTWARE, DISPOSITIVO",
  actividades: [{ giro: "X", codigoActividadEconomica: "641990", actividadPrincipal: true }],
};
const RECEPTOR = {
  rut: "76430498-5",
  razonSocial: "HOSTY SPA",
  direccion: "ARTURO PRAT 527",
  comuna: "Curicó",
  actividades: [{ giro: "ACTIVIDADES DE CONSULTORIA DE INFORMATICA Y DE GESTION", codigoActividadEconomica: "620200", actividadPrincipal: true }],
};
const REC_DTE = { RUTRecep: "76430498-5", RznSocRecep: "HOSTY SPA", GiroRecep: "CONSULTORIA", DirRecep: "ARTURO PRAT 527", CmnaRecep: "Curicó" };
const original = (tipo: number, totales: object, detalle: object[], receptor: object = REC_DTE) => ({
  json: {
    Encabezado: { IdDoc: { TipoDTE: tipo, FchEmis: "2026-09-20" }, Emisor: { RUTEmisor: "76795561-8" }, Receptor: receptor, Totales: totales },
    Detalle: detalle,
  },
});

const RUTAS: Record<string, unknown> = {
  "GET /organization": ORG,
  "GET /taxpayer/76430498-5": RECEPTOR,
  "GET /document/76795561-8/33/30/json": original(33, { MntNeto: 100000, TasaIVA: 19, IVA: 19000, MntTotal: 119000 }, [
    { NroLinDet: 1, NmbItem: "Servicio", QtyItem: 1, PrcItem: 100000, MontoItem: 100000 },
  ]),
  "GET /document/76795561-8/34/31/json": original(34, { MntExe: 50000, MntTotal: 50000 }, [
    { NroLinDet: 1, NmbItem: "Arriendo", QtyItem: 1, PrcItem: 50000, MontoItem: 50000, IndExe: 1 },
  ]),
  "GET /document/76795561-8/39/32/json": original(
    39,
    { MntNeto: 10000, IVA: 1900, MntTotal: 11900 },
    [{ NroLinDet: 1, NmbItem: "Producto", QtyItem: 1, PrcItem: 11900, MontoItem: 11900 }],
    { RUTRecep: "66666666-6", RznSocRecep: "Cliente", DirRecep: "Sin direccion", CmnaRecep: "Santiago" },
  ),
  "GET /document/76795561-8/61/33/json": original(61, { MntNeto: 10000, TasaIVA: 19, IVA: 1900, MntTotal: 11900 }, [
    { NroLinDet: 1, NmbItem: "Descuento", QtyItem: 1, PrcItem: 10000, MontoItem: 10000 },
  ]),
  "GET /document/76795561-8/52/34/json": original(52, { MntNeto: 5000, TasaIVA: 19, IVA: 950, MntTotal: 5950 }, []),
};

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const ruta = `${init?.method ?? "GET"} ${String(url).replace(BASE, "")}`;
  if (ruta === "POST /document/issued") return new Response(null, { status: 204 });
  const body = RUTAS[ruta];
  return new Response(JSON.stringify(body ?? { error: { message: `sin caso ${ruta}` } }), { status: body ? 200 : 404 });
}) as typeof fetch;

const F = ["--fecha", "2026-10-15"];
const R = ["--receptor", "76430498-5"];
export const CASOS: Record<string, string[]> = {
  "factura-simple": ["factura", ...R, "--item", "Servicio|1|100000"],
  "factura-varias-lineas": [
    "factura",
    ...R,
    "--item",
    "Producto|3|1500.5",
    "--item",
    '{"nombre":"Instalación","cantidad":1,"precio":20000,"descripcion":"En terreno, día hábil"}',
    "--item",
    "Arriendo bodega|1|50000|exento",
    "--forma-pago",
    "credito",
    "--correo",
    "pagos@hosty.cl",
    "--contacto",
    "Juan",
  ],
  "factura-con-iva": ["factura", ...R, "--item", "Plan anual|1|177310", "--con-iva"],
  "factura-con-referencias": ["factura", ...R, "--item", "Caja|5|1000", "--ref", "52:34", "--ref", "801:OC-55:2026-10-01"],
  "factura-exenta": ["factura-exenta", ...R, "--item", "Arriendo oficina sin amoblar|1|500000"],
  "boleta-consumidor-final": ["boleta", "--item", "Producto|2|11900", "--medio-pago", "transferencia"],
  "boleta-con-receptor": ["boleta", ...R, "--item", "Producto|1|1190", "--item", "Propina|1|100|exento"],
  "boleta-servicio-periodico": ["boleta", ...R, "--item", "Suscripción mensual|1|9990", "--ind-servicio", "2"],
  "boleta-exenta": ["boleta-exenta", "--item", "Entrada|1|5000"],
  "nc-anula-factura": ["nota-credito", "--referencia", "33:30", "--anula"],
  "nc-corrige-montos-factura": ["nota-credito", "--referencia", "33:30", "--corrige-montos", "--razon", "Descuento 10%", "--item", "Descuento|1|10000"],
  "nc-corrige-texto": ["nota-credito", "--referencia", "33:30", "--corrige-texto", "--razon", "Corrige dirección del receptor"],
  "nc-sin-rebaja": ["nota-credito", "--referencia", "33:30", "--corrige-montos", "--sin-rebaja", "--item", "Devolución|1|5000"],
  "nc-sobre-exenta": ["nota-credito", "--referencia", "34:31", "--corrige-montos", "--item", "Descuento|1|5000"],
  "nc-sobre-boleta": ["nota-credito", "--referencia", "39:32", "--corrige-montos", "--razon", "Devolución", "--item", "Devolución|1|1190"],
  "nc-anula-boleta": ["nota-credito", "--referencia", "39:32", "--anula"],
  "nd-corrige-montos": ["nota-debito", "--referencia", "33:30", "--corrige-montos", "--razon", "Intereses", "--item", "Intereses|1|2000"],
  "nd-anula-nc": ["nota-debito", "--referencia", "61:33", "--anula"],
  "guia-venta-completa": [
    "guia",
    ...R,
    "--item",
    "Caja|10|1000",
    "--traslado",
    "venta",
    "--despacho",
    "emisor-cliente",
    "--destino-direccion",
    "Calle Uno 123",
    "--destino-comuna",
    "Talca",
    "--chofer-rut",
    "11111111-1",
    "--chofer-nombre",
    "Juan Pérez",
    "--transportista-rut",
    "76430498-5",
    "--patente",
    "ABCD12",
    "--patente-carro",
    "JK1234",
  ],
  "guia-traslado-interno": [
    "guia",
    ...R,
    "--item",
    "Caja|10|0",
    "--traslado",
    "interno",
    "--destino-direccion",
    "Bodega 2",
    "--destino-comuna",
    "Talca",
    "--chofer-rut",
    "11111111-1",
    "--chofer-nombre",
    "Juan Pérez",
    "--transportista-rut",
    "76430498-5",
    "--patente",
    "ABCD12",
  ],
};

export async function generar(dir: string): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const archivos: string[] = [];
  for (const [nombre, argv] of Object.entries(CASOS)) {
    const out: string[] = [];
    const err: string[] = [];
    const codigo = await run(["emitir", ...argv, ...F], { OPENFACTURA_API_KEY: "k" }, { out: (s) => out.push(s), err: (s) => err.push(s) });
    if (codigo !== 0) throw new Error(`El caso ${nombre} no se pudo armar: ${err.join("")}`);
    const archivo = join(dir, `${nombre}.json`);
    writeFileSync(archivo, JSON.stringify(JSON.parse(out.join("")).dte, null, 2));
    archivos.push(archivo);
  }
  return archivos;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("uso: bun scripts/casos-xsd.ts <carpeta-de-salida>");
    process.exit(2);
  }
  for (const a of await generar(dir)) console.log(a);
}
