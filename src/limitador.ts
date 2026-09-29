export interface OpcionesLimitador {
  ahora?: () => number;
  esperar?: (ms: number) => Promise<void>;
  porSegundo?: number;
  porMinuto?: number;
}

export class Limitador {
  private readonly marcas: number[] = [];
  private cola: Promise<void> = Promise.resolve();
  private readonly ahora: () => number;
  private readonly esperar: (ms: number) => Promise<void>;
  private readonly porSegundo: number;
  private readonly porMinuto: number;

  constructor(opciones: OpcionesLimitador = {}) {
    this.ahora = opciones.ahora ?? Date.now;
    this.esperar = opciones.esperar ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.porSegundo = opciones.porSegundo ?? 3;
    this.porMinuto = opciones.porMinuto ?? 100;
  }

  turno(): Promise<void> {
    const siguiente = this.cola.then(() => this.esperarCupo());
    this.cola = siguiente.catch(() => undefined);
    return siguiente;
  }

  private async esperarCupo(): Promise<void> {
    for (;;) {
      const t = this.ahora();
      while (this.marcas.length && this.marcas[0]! <= t - 60_000) this.marcas.shift();
      const ultimoSegundo = this.marcas.filter((m) => m > t - 1000);
      let espera = 0;
      if (ultimoSegundo.length >= this.porSegundo) espera = ultimoSegundo[ultimoSegundo.length - this.porSegundo]! + 1000 - t;
      if (this.marcas.length >= this.porMinuto) espera = Math.max(espera, this.marcas[this.marcas.length - this.porMinuto]! + 60_000 - t);
      if (espera <= 0) {
        this.marcas.push(t);
        return;
      }
      await this.esperar(espera);
    }
  }
}
