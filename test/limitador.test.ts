import { describe, expect, test } from "bun:test";
import { Limitador } from "../src/limitador.ts";

function reloj() {
  let t = 0;
  const esperas: number[] = [];
  return {
    ahora: () => t,
    esperar: async (ms: number) => {
      esperas.push(ms);
      t += ms;
    },
    avanzar: (ms: number) => void (t += ms),
    esperas,
  };
}

describe("Limitador", () => {
  test("deja pasar 3 llamadas seguidas y hace esperar la cuarta hasta cumplir el segundo", async () => {
    const r = reloj();
    const l = new Limitador({ ahora: r.ahora, esperar: r.esperar });
    for (let i = 0; i < 3; i++) await l.turno();
    expect(r.esperas).toEqual([]);
    await l.turno();
    expect(r.esperas).toEqual([1000]);
  });

  test("nunca pasa de 100 llamadas en un minuto", async () => {
    const r = reloj();
    const l = new Limitador({ ahora: r.ahora, esperar: r.esperar });
    const marcas: number[] = [];
    for (let i = 0; i < 101; i++) {
      await l.turno();
      marcas.push(r.ahora());
    }
    const enElPrimerMinuto = marcas.filter((m) => m < 60_000).length;
    expect(enElPrimerMinuto).toBeLessThanOrEqual(100);
    expect(marcas.at(-1)!).toBeGreaterThanOrEqual(60_000);
  });

  test("si ya pasó el tiempo no hace esperar", async () => {
    const r = reloj();
    const l = new Limitador({ ahora: r.ahora, esperar: r.esperar });
    for (let i = 0; i < 3; i++) await l.turno();
    r.avanzar(1500);
    await l.turno();
    expect(r.esperas).toEqual([]);
  });

  test("las llamadas concurrentes también respetan el límite", async () => {
    const r = reloj();
    const l = new Limitador({ ahora: r.ahora, esperar: r.esperar });
    const marcas: number[] = [];
    await Promise.all(Array.from({ length: 6 }, () => l.turno().then(() => marcas.push(r.ahora()))));
    expect(marcas.filter((m) => m < 1000).length).toBeLessThanOrEqual(3);
  });
});
