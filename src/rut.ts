import { UsageError } from "./command.ts";

export function digitoVerificador(cuerpo: string): string {
  let suma = 0;
  let factor = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  return resto === 11 ? "0" : resto === 10 ? "K" : String(resto);
}

export function normalizarRut(entrada: string): string {
  const limpio = entrada.replace(/[.\s]/g, "").toUpperCase();
  const m = /^(\d{1,9})-?([\dK])$/.exec(limpio);
  if (!m) throw new UsageError(`"${entrada}" no es un RUT válido`);
  const [, cuerpo, dv] = m as unknown as [string, string, string];
  if (Number(cuerpo) === 0) throw new UsageError(`"${entrada}" no es un RUT válido`);
  if (digitoVerificador(cuerpo) !== dv) {
    throw new UsageError(`El RUT ${entrada} tiene mal el dígito verificador`);
  }
  return `${Number(cuerpo)}-${dv}`;
}

export function rutCuerpo(entrada: string): number {
  return Number(normalizarRut(entrada).split("-")[0]);
}
