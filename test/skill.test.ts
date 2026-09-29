import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function ejecutar(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const codigo = await run(argv, env, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { codigo, out: out.join("\n"), err: err.join("\n") };
}

describe("skill", () => {
  test("skill imprime el SKILL.md con su frontmatter, sin pedir clave", async () => {
    const r = await ejecutar(["skill"]);
    expect(r.codigo).toBe(0);
    expect(r.out.startsWith("---\nname: openfactura")).toBe(true);
    expect(r.out).toContain("--confirmar");
  });

  test("instalar-skill escribe el archivo en el destino", async () => {
    const d = mkdtempSync(join(tmpdir(), "sk-"));
    dirs.push(d);
    const r = await ejecutar(["instalar-skill", "--destino", d]);
    expect(r.codigo).toBe(0);
    const archivo = join(d, "openfactura", "SKILL.md");
    expect(existsSync(archivo)).toBe(true);
    expect(JSON.parse(r.out)).toMatchObject({ instalado: archivo });
  });

  test("instalar-skill por defecto va a ~/.claude/skills", async () => {
    const d = mkdtempSync(join(tmpdir(), "home-"));
    dirs.push(d);
    const r = await ejecutar(["instalar-skill"], { HOME: d, USERPROFILE: d });
    expect(r.codigo).toBe(0);
    expect(existsSync(join(d, ".claude", "skills", "openfactura", "SKILL.md"))).toBe(true);
  });

  test("reinstalar reemplaza una versión anterior", async () => {
    const d = mkdtempSync(join(tmpdir(), "sk-"));
    dirs.push(d);
    await ejecutar(["instalar-skill", "--destino", d]);
    writeFileSync(join(d, "openfactura", "SKILL.md"), "vieja");
    await ejecutar(["instalar-skill", "--destino", d]);
    expect(readFileSync(join(d, "openfactura", "SKILL.md"), "utf8")).not.toBe("vieja");
  });
});
