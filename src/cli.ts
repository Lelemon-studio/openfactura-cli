import { parseArgs } from "node:util";
import { ApiError, OpenFacturaClient } from "./client.ts";
import { type Config, ConfigError, resolveConfig } from "./config.ts";
import { type Comando, type IO, UsageError, ValidationError } from "./command.ts";
import { COMANDOS } from "./commands/index.ts";
import { VERSION } from "./version.ts";

const FLAGS_GLOBALES = {
  "api-key": { type: "string" },
  dev: { type: "boolean" },
  timeout: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

function ayudaGeneral(): string {
  const ancho = Math.max(...COMANDOS.map((c) => c.nombre.length));
  const lineas = COMANDOS.map((c) => `  ${c.nombre.padEnd(ancho)}  ${c.resumen}`);
  return [
    `openfactura ${VERSION} · CLI para la API de OpenFactura (Haulmer)`,
    "",
    "Uso: openfactura <comando> [argumentos] [opciones]",
    "",
    "Comandos:",
    ...lineas,
    "",
    "Opciones globales:",
    "  --api-key <clave>  API key (o variable OPENFACTURA_API_KEY)",
    "  --dev              Usa el ambiente de pruebas dev-api.haulmer.com (o OPENFACTURA_ENV=dev)",
    "  --timeout <ms>     Tiempo máximo por llamada (default 60000)",
    "  -h, --help         Ayuda general o de un comando",
    "  --version          Versión",
    "",
    "La salida es JSON en stdout. Los errores salen como JSON en stderr, con código 1 si los",
    "rechazó OpenFactura y 2 si el problema está en los argumentos o la configuración.",
  ].join("\n");
}

function ayudaComando(c: Comando): string {
  return [`openfactura ${c.nombre} · ${c.resumen}`, "", c.uso].join("\n");
}

function buscarComando(posicionales: string[]): { comando: Comando; resto: string[] } | null {
  const ordenados = [...COMANDOS].sort((a, b) => b.nombre.split(" ").length - a.nombre.split(" ").length);
  for (const c of ordenados) {
    const partes = c.nombre.split(" ");
    if (partes.every((p, i) => posicionales[i] === p)) return { comando: c, resto: posicionales.slice(partes.length) };
  }
  return null;
}

function error(io: IO, cuerpo: Record<string, unknown>, codigo: number): number {
  io.err(JSON.stringify(cuerpo, null, 2));
  return codigo;
}

export async function run(argv: string[], env: Record<string, string | undefined>, io: IO): Promise<number> {
  if (argv[0] === "--version") {
    io.out(VERSION);
    return 0;
  }

  const previos: string[] = [];
  let i = 0;
  while (i < argv.length && argv[i]!.startsWith("-")) {
    const a = argv[i]!;
    const nombre = a.replace(/^--?/, "").split("=")[0]!;
    const conValor = nombre === "api-key" || nombre === "timeout";
    if (!(nombre in FLAGS_GLOBALES) && nombre !== "h") {
      return error(io, { error: `Opción desconocida antes del comando: ${a}. Mira openfactura --help`, code: "USAGE" }, 2);
    }
    previos.push(a);
    if (conValor && !a.includes("=")) {
      const valor = argv[++i];
      const invalido = valor === undefined || valor.startsWith("-") || (nombre === "timeout" && !/^\d+$/.test(valor));
      if (invalido) return error(io, { error: `${a} necesita un valor${nombre === "timeout" ? " en milisegundos" : ""}`, code: "USAGE" }, 2);
      previos.push(valor);
    }
    i++;
  }
  argv = argv.slice(i);

  if (argv.length === 0) {
    io.out(ayudaGeneral());
    return 0;
  }

  const inicial = argv.findIndex((a) => a.startsWith("-"));
  const cabeza = inicial === -1 ? argv : argv.slice(0, inicial);
  const encontrado = buscarComando(cabeza);
  if (!encontrado) {
    return error(io, { error: `Comando desconocido: ${cabeza.join(" ") || argv[0]}. Mira openfactura --help`, code: "USAGE" }, 2);
  }
  const { comando } = encontrado;
  const saltar = comando.nombre.split(" ").length;

  try {
    const { values, positionals } = parseArgs({
      args: [...argv.slice(saltar), ...previos],
      options: { ...FLAGS_GLOBALES, ...(comando.flags ?? {}) },
      allowPositionals: true,
      strict: true,
    });
    if (values.help) {
      io.out(ayudaComando(comando));
      return 0;
    }
    const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647)) {
      throw new UsageError("--timeout debe ser un número de milisegundos, de 1 a 2147483647");
    }
    if (comando.maxArgs !== undefined && positionals.length > comando.maxArgs) {
      throw new UsageError(`Sobran argumentos: ${positionals.slice(comando.maxArgs).join(" ")}. Mira openfactura ${comando.nombre} --help`);
    }
    if (comando.minArgs !== undefined && positionals.length < comando.minArgs) {
      throw new UsageError(`Faltan argumentos. Uso: ${comando.uso}`);
    }
    let config = undefined as unknown as Config;
    let client = undefined as unknown as OpenFacturaClient;
    if (!comando.sinClave) {
      config = resolveConfig({ apiKey: values["api-key"] as string | undefined, dev: values.dev as boolean | undefined, timeoutMs: timeout }, env);
      client = new OpenFacturaClient(config);
    }
    const resultado = await comando.run({ client, config, flags: values, args: positionals, io, env });
    if (resultado !== undefined) io.out(JSON.stringify(resultado, null, 2));
    return 0;
  } catch (e) {
    if (e instanceof ApiError) return error(io, e.toJSON(), 1);
    if (e instanceof ValidationError) return error(io, { error: e.message, code: e.code, details: e.details }, 2);
    if (e instanceof UsageError || e instanceof ConfigError) return error(io, { error: e.message, code: e.code }, 2);
    const sistema = e as { code?: string; syscall?: string; path?: string };
    if (sistema.syscall) {
      return error(
        io,
        {
          error: `No se pudo ${sistema.syscall === "open" ? "escribir o leer" : sistema.syscall} ${sistema.path ?? "el archivo"}: ${sistema.code}`,
          code: "FILE",
        },
        2,
      );
    }
    const nodeCode = sistema.code;
    if (typeof nodeCode === "string" && nodeCode.startsWith("ERR_PARSE_ARGS")) {
      return error(io, { error: (e as Error).message, code: "USAGE" }, 2);
    }
    return error(io, { error: String((e as Error)?.message ?? e), code: "INTERNAL" }, 1);
  }
}
