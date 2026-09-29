import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Comando, texto } from "../command.ts";
import SKILL from "../../skill/SKILL.md" with { type: "text" };

function carpetaSkills(env: Record<string, string | undefined>): string {
  const casa = env.HOME || env.USERPROFILE || homedir();
  return join(casa, ".claude", "skills");
}

export const SKILLS: Comando[] = [
  {
    nombre: "skill",
    resumen: "Imprime la skill para que Claude sepa usar este CLI",
    uso: "openfactura skill",
    sinClave: true,
    maxArgs: 0,
    run: ({ io }) => {
      io.out(SKILL);
      return undefined;
    },
  },
  {
    nombre: "instalar-skill",
    resumen: "Instala la skill en Claude Code (~/.claude/skills/openfactura)",
    uso: [
      "openfactura instalar-skill [--destino <carpeta-de-skills>]",
      "",
      "Por defecto la deja en ~/.claude/skills/openfactura/SKILL.md, disponible en todos tus proyectos.",
      "Para un solo proyecto: --destino .claude/skills",
    ].join("\n"),
    sinClave: true,
    maxArgs: 0,
    flags: { destino: { type: "string" } },
    run: ({ flags, env }) => {
      const carpeta = join(texto(flags, "destino") ?? carpetaSkills(env), "openfactura");
      mkdirSync(carpeta, { recursive: true });
      const archivo = join(carpeta, "SKILL.md");
      writeFileSync(archivo, SKILL);
      return { instalado: archivo, siguiente: "Reinicia Claude Code para que la cargue." };
    },
  },
];
