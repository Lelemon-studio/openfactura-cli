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
    throw new ConfigError(
      "Falta la API key de OpenFactura. Pásala con --api-key o en la variable OPENFACTURA_API_KEY.",
    );
  }

  const envVar = env.OPENFACTURA_ENV?.trim().toLowerCase();
  if (envVar && envVar !== "prod" && envVar !== "dev") {
    throw new ConfigError(`OPENFACTURA_ENV="${envVar}" no existe. Usa "prod" o "dev".`);
  }
  const ambiente: Ambiente = flags.dev || envVar === "dev" ? "dev" : "prod";

  return { apiKey, env: ambiente, baseUrl: BASE_URLS[ambiente], timeoutMs: flags.timeoutMs ?? 60_000 };
}
