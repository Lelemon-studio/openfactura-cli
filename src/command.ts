import type { ParseArgsConfig } from "node:util";
import type { OpenFacturaClient } from "./client.ts";
import type { Config } from "./config.ts";

export type Flags = Record<string, string | boolean | string[] | undefined>;

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface Contexto {
  client: OpenFacturaClient;
  config: Config;
  flags: Flags;
  args: string[];
  io: IO;
  env: Record<string, string | undefined>;
}

export interface Comando {
  nombre: string;
  resumen: string;
  uso: string;
  flags?: NonNullable<ParseArgsConfig["options"]>;
  sinClave?: boolean;
  minArgs?: number;
  maxArgs?: number;
  run: (ctx: Contexto) => unknown;
}

export class UsageError extends Error {
  code = "USAGE";
}

export class ValidationError extends Error {
  code = "VALIDATION";
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function texto(flags: Flags, nombre: string): string | undefined {
  const v = flags[nombre];
  return typeof v === "string" ? v : undefined;
}

export function requerido(flags: Flags, nombre: string): string {
  const v = texto(flags, nombre);
  if (v === undefined || v.trim() === "") throw new UsageError(`Falta --${nombre}`);
  return v;
}

export function arg(ctx: Contexto, i: number, nombre: string): string {
  const v = ctx.args[i];
  if (v === undefined) throw new UsageError(`Falta el argumento <${nombre}>`);
  return v;
}

export function entero(valor: string | undefined, nombre: string): number {
  if (valor === undefined || !/^\d+$/.test(valor.trim())) throw new UsageError(`${nombre} debe ser un número entero, llegó "${valor}"`);
  return Number(valor);
}
