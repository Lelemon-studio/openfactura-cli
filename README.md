# openfactura-cli

CLI para la API de [OpenFactura](https://www.openfactura.cl) (Haulmer): emite y consulta documentos
tributarios electrónicos del SII desde la terminal. Está pensado para que Claude lo opere por ti, pero
funciona igual a mano.

- Cubre la API documentada completa: emisión, consulta de documentos, emitidos, recibidos, acuses,
  registro de compras y ventas, ficha de contribuyentes y anulación de guías.
- Resuelve adentro las trampas de la API: la boleta con un esquema distinto al de la factura, el PDF en
  base64, los filtros que se ignoran en silencio, el límite de llamadas por segundo, los errores en tres
  formatos distintos.
- **Emitir es en seco por defecto.** Sin `--confirmar` arma el documento, calcula los totales y te lo
  muestra sin mandar nada al SII.
- Salida JSON siempre. Cero dependencias en runtime.

## Instalación

Necesitas Node 20 o superior.

```bash
npm install -g github:Lelemon-studio/openfactura-cli
openfactura --version
```

O desde una copia local: `git clone https://github.com/Lelemon-studio/openfactura-cli && cd openfactura-cli && npm install -g .`

Sin Node, el binario de Windows se arma con `bun run build` y queda en `dist/openfactura.exe`. Para
otros sistemas: `bun build src/main.ts --compile --target=bun-linux-x64 --outfile dist/openfactura`
(o `bun-darwin-arm64`, `bun-darwin-x64`).

## API key

La API key sale de tu cuenta de OpenFactura. Déjala en una variable de entorno, nunca en un archivo
versionado:

```bash
export OPENFACTURA_API_KEY="tu-clave"          # macOS / Linux
$env:OPENFACTURA_API_KEY = "tu-clave"          # PowerShell
```

También se acepta `OPENFACTURA_KEY`, o `--api-key` en cada comando. La clave nunca aparece en la salida
ni en los mensajes de error.

## Primeros pasos

```bash
openfactura emisor                    # ¿con qué empresa estoy operando?
openfactura ventas 2026-09            # resumen de ventas del mes
openfactura contribuyente 76430498-5  # ficha SII de un RUT
```

Emitir una factura, primero en seco:

```bash
openfactura emitir factura --receptor 76430498-5 --item "Servicio de septiembre|1|100000"
```

La salida trae un `resumen` con receptor, neto, IVA y total, y el DTE completo. Si está bien, repite el
comando con `--confirmar`. Repetir exactamente el mismo comando no emite dos veces: la clave de
idempotencia es el hash del documento, y OpenFactura la recuerda 24 horas.

```bash
openfactura emitir factura --receptor 76430498-5 --item "Servicio de septiembre|1|100000" --confirmar --esperar 120
```

## Comandos

| Comando | Para qué |
|---|---|
| `emisor` | Datos de la empresa dueña de la API key |
| `folios` | Tipos de documento autorizados |
| `contribuyente <rut>` | Ficha SII de cualquier RUT, y si tiene giro para recibir factura |
| `emitir <tipo>` | `factura`, `factura-exenta`, `boleta`, `boleta-exenta`, `nota-credito`, `nota-debito`, `guia` |
| `emitir archivo <dte.json>` | Cualquier DTE ya armado, incluidos los tipos sin constructor (43, 46) |
| `documento <estado\|json\|xml\|pdf\|cedible>` | Un documento por tipo y folio, o por token |
| `emitidos` / `recibidos` | Listados con filtros por fecha, tipo, RUT y folio |
| `acusar` | Acepta o reclama un documento recibido (pide `--confirmar`) |
| `ventas` / `compras` | Registro de ventas y compras de un mes o un día |
| `sincronizar-rcv` | Pide a OpenFactura traer el RCV del SII |
| `anular-guia` | Anula una guía de despacho (pide `--confirmar`) |
| `skill` / `instalar-skill` | La skill para Claude Code |

`openfactura <comando> --help` muestra todas las opciones de cada uno.

## Con Claude Code

```bash
openfactura instalar-skill
```

Deja la skill en `~/.claude/skills/openfactura/`. Desde ahí basta con pedirle a Claude cosas como
"emítele una factura a 76.430.498-5 por 100 mil neto" o "¿el SII aceptó la factura 31?". La skill le
indica mostrarte el resumen en seco y esperar tu aprobación antes de emitir.

## Ambiente de pruebas

`--dev` (u `OPENFACTURA_ENV=dev`) apunta a `dev-api.haulmer.com`. La documentación de OpenFactura
publica una clave demo para ese ambiente, `928e15a2d14d4a6292345f04960f4bd3`, con un emisor de pruebas.
Lo que se emite ahí no llega al SII.

```bash
OPENFACTURA_API_KEY=928e15a2d14d4a6292345f04960f4bd3 openfactura emitir boleta --dev --item "Prueba|1|1190" --confirmar
```

## Desarrollo

```bash
bun install
bun test               # tests unitarios, sin red
bun run typecheck
bun scripts/probar-dev.ts   # emite todos los tipos contra el ambiente de pruebas
bun run build          # dist/cli.js para Node y dist/openfactura(.exe)
```

`dist/cli.js` va versionado para que se pueda instalar directo desde GitHub sin Bun. Después de
cambiar `src/`, corre `bun run build:node` y commitea el resultado: el CI falla si quedó desactualizado.

El catálogo de la API, con cada dato marcado como verificado contra la API real, documentado o inferido,
está en [`docs/API.md`](docs/API.md).

## Licencia

MIT. Hecho por [Lelemon](https://lelemon.cl). No es un producto oficial de Haulmer ni de OpenFactura.
