import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CASOS, generar } from "./casos-xsd.ts";

const VALIDADOR = join(import.meta.dir, "..", "test", "xsd", "validar.py");
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

const prueba = spawnSync(python, ["-c", "import lxml"], { encoding: "utf8" });
if (prueba.status !== 0) {
  console.error(`No se puede validar: falta Python con lxml (${python}). Instálalo con: pip install lxml`);
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "of-xsd-"));
let fallos = 0;
try {
  const archivos = await generar(dir);
  if (archivos.length !== Object.keys(CASOS).length) throw new Error("No se generaron todos los casos");
  for (const archivo of archivos) {
    const r = spawnSync(python, [VALIDADOR, archivo, "--estricto"], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    const nombre = basename(archivo, ".json");
    if (r.status === 0) {
      console.log(`OK     ${nombre}`);
    } else {
      fallos++;
      console.log(`FALLA  ${nombre}`);
      for (const linea of `${r.stdout}${r.stderr}`.split("\n").filter((l) => /^(AVISO|ERROR|XSD)/.test(l))) console.log(`       ${linea}`);
    }
  }
  console.log(`\n${archivos.length - fallos} de ${archivos.length} casos cumplen el XSD del SII`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exitCode = fallos ? 1 : 0;
