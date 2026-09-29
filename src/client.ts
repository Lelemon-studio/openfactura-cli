import { Limitador } from "./limitador.ts";

export interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  limite?: { porSegundo: number; porMinuto: number } | null;
  esperar?: (ms: number) => Promise<void>;
  ahora?: () => number;
}

export interface RequestOptions {
  idempotencyKey?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  toJSON() {
    return { error: this.message, status: this.status, code: this.code, details: this.details };
  }
}

const MAX_REINTENTOS_429 = 3;
const MAX_ESPERA_429_S = 60;
const utf8Estricto = new TextDecoder("utf-8", { fatal: true });
const latin1 = new TextDecoder("latin1");

function decodificar(bytes: ArrayBuffer): string {
  try {
    return utf8Estricto.decode(bytes);
  } catch {
    return latin1.decode(bytes);
  }
}

function parsear(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

export class OpenFacturaClient {
  private readonly limitador: Limitador | null;

  constructor(private readonly opts: ClientOptions) {
    this.limitador = opts.limite ? new Limitador({ ...opts.limite, esperar: opts.esperar, ahora: opts.ahora }) : null;
  }

  get(path: string): Promise<unknown> {
    return this.request("GET", path);
  }

  post(path: string, body: unknown, options: RequestOptions = {}): Promise<unknown> {
    return this.request("POST", path, body, options);
  }

  private async request(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<unknown> {
    const esperar = this.opts.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let intento = 0; ; intento++) {
      try {
        return await this.unaVez(method, path, body, options);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 429 || e.code === "OF-429") throw e;
        if (intento >= MAX_REINTENTOS_429) {
          throw new ApiError(`OpenFactura sigue limitando las llamadas después de ${MAX_REINTENTOS_429} reintentos: ${e.message}`, 429, "RATE_LIMIT");
        }
        const segundos = Math.max(1, Number(/(\d+)\s*second/i.exec(e.message)?.[1] ?? 1));
        if (segundos > MAX_ESPERA_429_S) {
          throw new ApiError(`OpenFactura pide esperar ${segundos} segundos antes de volver a llamar`, 429, "RATE_LIMIT");
        }
        await esperar(segundos * 1000);
      }
    }
  }

  private async unaVez(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<unknown> {
    const headers: Record<string, string> = { apikey: this.opts.apiKey, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    await this.limitador?.turno();
    const control = new AbortController();
    let vencido = false;
    const reloj = setTimeout(() => {
      vencido = true;
      control.abort();
    }, this.opts.timeoutMs);

    let res: Response;
    let bytes: ArrayBuffer;
    try {
      res = await fetch(this.opts.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: control.signal,
      });
      bytes = await res.arrayBuffer();
    } catch (e) {
      if (vencido) {
        const extra =
          method === "POST"
            ? ". La operación pudo haberse procesado igual: repite exactamente el mismo comando, que la idempotencia evita duplicarla"
            : "";
        throw new ApiError(`OpenFactura no respondió en ${this.opts.timeoutMs} ms${extra}`, 0, "TIMEOUT");
      }
      throw new ApiError(`No se pudo conectar con OpenFactura: ${this.ocultar(String(e))}`, 0, "NETWORK");
    } finally {
      clearTimeout(reloj);
    }

    const texto = decodificar(bytes);
    const data = texto.trim() === "" ? null : parsear(texto);
    if (res.ok) return data;
    throw this.error(res.status, data);
  }

  private error(status: number, data: unknown): ApiError {
    const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const interno = (d.error && typeof d.error === "object" ? d.error : d) as Record<string, unknown>;
    const mensaje =
      typeof interno.message === "string"
        ? interno.message
        : typeof d.error === "string"
          ? d.error
          : typeof data === "string"
            ? data.slice(0, 500)
            : `HTTP ${status}`;
    const codigo =
      typeof interno.code === "string" ? interno.code : status === 401 || status === 403 ? "AUTH" : `HTTP_${status}`;
    const reconocido = typeof interno.message === "string" || typeof d.error === "string";
    const detalles = interno.details ?? (reconocido || typeof data === "string" ? undefined : data);
    return new ApiError(this.ocultar(mensaje), status, codigo, this.ocultarEn(detalles));
  }

  private ocultar(texto: string): string {
    return this.opts.apiKey ? texto.split(this.opts.apiKey).join("***") : texto;
  }

  private ocultarEn(valor: unknown): unknown {
    if (valor === undefined || !this.opts.apiKey) return valor;
    return JSON.parse(this.ocultar(JSON.stringify(valor)));
  }
}
