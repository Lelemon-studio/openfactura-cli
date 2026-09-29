import type { Comando } from "../command.ts";
import { LECTURAS } from "./lecturas.ts";
import { EMISION } from "./emitir/index.ts";
import { SKILLS } from "./skill.ts";

export const COMANDOS: Comando[] = [...LECTURAS, ...EMISION, ...SKILLS];
