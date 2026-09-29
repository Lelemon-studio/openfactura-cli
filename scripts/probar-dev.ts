import { run } from "../src/cli.ts";

const CLAVE_DEMO = "928e15a2d14d4a6292345f04960f4bd3";
const RECEPTOR_DEMO = "76430498-5";
const env = { OPENFACTURA_API_KEY: CLAVE_DEMO, OPENFACTURA_ENV: "dev" };

async function cli(...argv: string[]): Promise<{ codigo: number; out: any; err: any }> {
  const out: string[] = [];
  const err: string[] = [];
  const codigo = await run(argv, env, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { codigo, out: out.length ? JSON.parse(out.join("")) : undefined, err: err.length ? JSON.parse(err.join("")) : undefined };
}

const marca = `prueba-${Date.now()}`;
const casos: Array<[string, string[]]> = [
  ["factura", ["emitir", "factura", "--receptor", RECEPTOR_DEMO, "--item", `Servicio ${marca}|1|10000`, "--item", "Envío|1|2000|exento"]],
  ["factura-exenta", ["emitir", "factura-exenta", "--receptor", RECEPTOR_DEMO, "--item", `Asesoría ${marca}|2|15000`]],
  ["boleta", ["emitir", "boleta", "--item", `Producto ${marca}|3|1190`]],
  ["boleta-exenta", ["emitir", "boleta-exenta", "--item", `Curso ${marca}|1|5000`]],
  [
    "guia",
    [
      "emitir",
      "guia",
      "--receptor",
      RECEPTOR_DEMO,
      "--item",
      `Caja ${marca}|5|1000`,
      "--traslado",
      "venta",
      "--despacho",
      "emisor-cliente",
      "--destino-direccion",
      "Calle 1",
      "--destino-comuna",
      "Talca",
      "--chofer-rut",
      "11111111-1",
      "--chofer-nombre",
      "Juan Perez",
      "--transportista-rut",
      RECEPTOR_DEMO,
      "--patente",
      "ABCD12",
    ],
  ],
];

let fallos = 0;
const emitidos: Record<string, number> = {};
for (const [nombre, argv] of casos) {
  const r = await cli(...argv, "--confirmar");
  const ok = r.codigo === 0 && typeof r.out?.folio === "number";
  if (ok) emitidos[nombre] = r.out.folio;
  else fallos++;
  console.log(`${ok ? "OK  " : "FALLA"} ${nombre.padEnd(15)} ${ok ? `folio ${r.out.folio} total ${r.out.total}` : JSON.stringify(r.err ?? r.out)}`);
}

if (emitidos.factura) {
  for (const [nombre, argv] of [
    [
      "nota-credito montos",
      ["emitir", "nota-credito", "--referencia", `33:${emitidos.factura}`, "--corrige-montos", "--razon", "Descuento", "--item", "Descuento|1|3000"],
    ],
    [
      "nota-debito",
      ["emitir", "nota-debito", "--referencia", `33:${emitidos.factura}`, "--corrige-montos", "--razon", "Intereses", "--item", "Intereses|1|500"],
    ],
  ] as Array<[string, string[]]>) {
    const r = await cli(...argv, "--confirmar");
    const ok = r.codigo === 0 && typeof r.out?.folio === "number";
    if (!ok) fallos++;
    console.log(`${ok ? "OK  " : "FALLA"} ${nombre.padEnd(20)} ${ok ? `folio ${r.out.folio} total ${r.out.total}` : JSON.stringify(r.err ?? r.out)}`);
  }

  if (emitidos.boleta) {
    for (const [nombre, argv] of [
      [
        "nota-credito boleta",
        ["emitir", "nota-credito", "--referencia", `39:${emitidos.boleta}`, "--corrige-montos", "--razon", "Devolucion", "--item", "Devolucion|1|1190"],
      ],
    ] as Array<[string, string[]]>) {
      const r = await cli(...argv, "--confirmar");
      const ok = r.codigo === 0 && typeof r.out?.folio === "number";
      if (!ok) fallos++;
      console.log(`${ok ? "OK  " : "FALLA"} ${nombre.padEnd(26)} ${ok ? `folio ${r.out.folio} total ${r.out.total}` : JSON.stringify(r.err ?? r.out)}`);
    }
  }
  if (emitidos.guia) {
    const r = await cli("emitir", "factura", "--receptor", RECEPTOR_DEMO, "--item", `Caja ${marca}|5|1000`, "--ref", `52:${emitidos.guia}`, "--confirmar");
    const ok = r.codigo === 0 && typeof r.out?.folio === "number";
    if (!ok) fallos++;
    console.log(`${ok ? "OK  " : "FALLA"} factura que cita la guía     ${ok ? `folio ${r.out.folio}` : JSON.stringify(r.err ?? r.out)}`);
  }

  for (const [nombre, argv] of [
    ["anular factura con NC previa", ["emitir", "nota-credito", "--referencia", `33:${emitidos.factura}`, "--anula"]],
    ["anular boleta con NC previa", ["emitir", "nota-credito", "--referencia", `39:${emitidos.boleta}`, "--anula"]],
  ] as Array<[string, string[]]>) {
    const r = await cli(...argv, "--confirmar");
    const ok = r.codigo === 2 && String(r.err?.error ?? "").includes("61:");
    if (!ok) fallos++;
    console.log(
      `${ok ? "OK  " : "FALLA"} ${nombre.padEnd(28)} ${ok ? `bloqueada: ${r.err.error.slice(0, 120)}` : JSON.stringify(r.err ?? r.out).slice(0, 200)}`,
    );
  }
  const anula = await cli("emitir", "factura", "--receptor", RECEPTOR_DEMO, "--item", `Para anular ${marca}|1|5000`, "--confirmar");
  if (anula.codigo === 0) {
    const r = await cli("emitir", "nota-credito", "--referencia", `33:${anula.out.folio}`, "--anula", "--confirmar");
    const ok = r.codigo === 0 && typeof r.out?.folio === "number";
    if (!ok) fallos++;
    console.log(
      `${ok ? "OK  " : "FALLA"} anular factura limpia          ${ok ? `folio ${r.out.folio} total ${r.out.total}` : JSON.stringify(r.err ?? r.out).slice(0, 200)}`,
    );
  }

  const estado = await cli("documento", "estado", "33", String(emitidos.factura));
  console.log(`estado factura ${emitidos.factura}: ${JSON.stringify(estado.out ?? estado.err)}`);
  const repetida = await cli(...casos[0]![1], "--confirmar");
  const idem = repetida.codigo === 0 && repetida.out?.yaEmitido === true && repetida.out?.emitido === false;
  if (!idem) fallos++;
  console.log(`${idem ? "OK  " : "FALLA"} repetir la misma factura no la emite dos veces: ${JSON.stringify(repetida.err ?? repetida.out).slice(0, 200)}`);
}

console.log(fallos ? `\n${fallos} caso(s) fallaron` : "\nTodos los casos emitieron en dev");
process.exitCode = fallos ? 1 : 0;
