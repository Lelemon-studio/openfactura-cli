export const BASE_URLS = {
  prod: "https://api.haulmer.com/v2/dte",
  dev: "https://dev-api.haulmer.com/v2/dte",
} as const;

export type Ambiente = keyof typeof BASE_URLS;

export interface Config {
  apiKey: string;
  env: Ambiente;
  baseUrl: string;
  timeoutMs: number;
  limite: Limite | null;
}

export interface Limite {
  porSegundo: number;
  porMinuto: number;
}

export interface FlagsConfig {
  apiKey?: string;
  dev?: boolean;
  timeoutMs?: number;
}

export class ConfigError extends Error {
  code = "CONFIG";
}

export function resolveConfig(flags: FlagsConfig, env: Record<string, string | undefined>): Config {
  const apiKey = (flags.apiKey ?? env.OPENFACTURA_API_KEY ?? env.OPENFACTURA_KEY ?? "").trim();
  if (!apiKey) {
    throw new ConfigError("Falta la API key de OpenFactura. Pásala con --api-key o en la variable OPENFACTURA_API_KEY.");
  }

  const envVar = env.OPENFACTURA_ENV?.trim().toLowerCase();
  if (envVar && envVar !== "prod" && envVar !== "dev") {
    throw new ConfigError(`OPENFACTURA_ENV="${envVar}" no existe. Usa "prod" o "dev".`);
  }
  const ambiente: Ambiente = flags.dev || envVar === "dev" ? "dev" : "prod";

  return { apiKey, env: ambiente, baseUrl: BASE_URLS[ambiente], timeoutMs: flags.timeoutMs ?? 60_000, limite: limite(env.OPENFACTURA_LIMITE) };
}

function limite(valor: string | undefined): Limite | null {
  const v = valor?.trim();
  if (!v) return { porSegundo: 3, porMinuto: 100 };
  if (v === "0") return null;
  const m = /^(\d+)\/(\d+)$/.exec(v);
  const porSegundo = Number(m?.[1]);
  const porMinuto = Number(m?.[2]);
  if (!m || porSegundo < 1 || porMinuto < 1) {
    throw new ConfigError(`OPENFACTURA_LIMITE="${v}" no se entiende. Usa llamadas por segundo y por minuto, como "3/100", o "0" para desactivarlo.`);
  }
  return { porSegundo, porMinuto };
}
