# openfactura-cli

> Proyecto independiente de [Lelemon](https://lelemon.cl). No es un producto oficial de Haulmer ni de
> OpenFactura, ni está afiliado a ellos. "OpenFactura" y "Haulmer" son marcas de sus dueños.

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
- Arma los documentos en el orden y con los largos del esquema oficial del SII (`DTE_v10.xsd` y
  `EnvioBOLETA_v11.xsd`), y los tests validan contra esos XSD.

> **Emitir no tiene vuelta atrás.** Un documento aceptado por el SII es evidencia tributaria: no se borra
> ni se edita, se corrige emitiendo una nota de crédito. Revisa la salida en seco antes de agregar
> `--confirmar`, y prueba primero en el [ambiente de pruebas](#ambiente-de-pruebas).

## Instalación

Necesitas Node 20 o superior.

```bash
npm install -g https://github.com/Lelemon-studio/openfactura-cli/releases/download/v0.2.0/openfactura-cli-0.2.0.tgz
openfactura --version
```

Las versiones están en [Releases](https://github.com/Lelemon-studio/openfactura-cli/releases). También
funciona desde una copia local: `git clone https://github.com/Lelemon-studio/openfactura-cli`, y dentro de
la carpeta `npm install -g .`

En Windows, evita `npm install -g github:Lelemon-studio/openfactura-cli`: npm deja el comando apuntando a
una carpeta temporal que después borra, y `openfactura` falla con `Cannot find module`.

Para usarlo sin Node, `bun run build` compila un binario para el sistema donde lo corres, en
`dist/openfactura` (`dist/openfactura.exe` en Windows). Para otro sistema:
`bun build src/main.ts --compile --target=bun-linux-x64 --outfile dist/openfactura` (o `bun-darwin-arm64`,
`bun-darwin-x64`, `bun-windows-x64`).

## API key

La API key la entrega OpenFactura para tu empresa: búscala en tu cuenta o pídela a su soporte. Cada
clave opera sobre un solo emisor, y `openfactura emisor` te dice cuál. Déjala en una variable de
entorno, nunca en un archivo versionado:

```bash
export OPENFACTURA_API_KEY="tu-clave"          # macOS / Linux
$env:OPENFACTURA_API_KEY = "tu-clave"          # PowerShell
```

También se acepta `OPENFACTURA_KEY`, o `--api-key` en cada comando. Evita `--api-key` fuera de una
prueba: queda en el historial de la terminal y a la vista en la lista de procesos. El CLI nunca muestra
la clave en la salida ni en los mensajes de error.

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

## Límite de llamadas

OpenFactura acepta 3 llamadas por segundo y 100 por minuto. El CLI espera su turno solo para no pasarse,
así que un listado largo o una nota de crédito que revisa notas previas puede tardar. Si tu cuenta tiene
otro límite, ajústalo con `OPENFACTURA_LIMITE=5/200`, o desactívalo con `OPENFACTURA_LIMITE=0`.

Si un listado falla a mitad de camino, devuelve lo que alcanzó a bajar con `"incompleto": true` y un aviso.

## Ambiente de pruebas

`--dev` (u `OPENFACTURA_ENV=dev`) apunta a `dev-api.haulmer.com`. La documentación de OpenFactura
publica una clave demo para ese ambiente, `928e15a2d14d4a6292345f04960f4bd3`, con un emisor de pruebas.
Lo que se emite ahí no llega al SII.

```bash
OPENFACTURA_API_KEY=928e15a2d14d4a6292345f04960f4bd3 openfactura emitir boleta --dev --item "Prueba|1|1190" --confirmar
```

En PowerShell la variable va en una línea aparte:

```powershell
$env:OPENFACTURA_API_KEY = "928e15a2d14d4a6292345f04960f4bd3"
openfactura emitir boleta --dev --item "Prueba|1|1190" --confirmar
```

## Errores

Los errores salen por stderr como `{"error": "...", "code": "...", "details": ...}`. El código de salida
es `1` si el problema vino de OpenFactura, el SII o la red, y `2` si está en lo que se le pasó al CLI.

| `code` | Salida | Qué pasó |
|---|---|---|
| `USAGE` | 2 | Falta o sobra un argumento, o una opción no existe |
| `VALIDATION` | 2 | El documento no se puede emitir así (montos, RUT, receptor, reglas del SII) |
| `CONFIG` | 2 | Falta la API key o una variable de entorno tiene un valor que no se entiende |
| `FILE` | 2 | No se pudo leer o escribir un archivo local |
| `AUTH` | 1 | OpenFactura rechazó la API key |
| `RATE_LIMIT` | 1 | OpenFactura siguió limitando las llamadas después de reintentar |
| `TIMEOUT` | 1 | La API no respondió a tiempo. En una emisión, repite el mismo comando: no emite dos veces |
| `NETWORK` | 1 | No se pudo conectar |
| `INVALID_RESPONSE` | 1 | La API respondió algo que no se pudo interpretar |
| `INTERNAL` | 1 | Un error del CLI. Si lo ves, abre un issue |
| `NO_ISSUER`, `NO_FILE`, `INVALID_FILE`, `INVALID_PDF` | 1 | La API respondió sin el dato pedido |
| `OF-xx`, `HTTP_xxx` | 1 | Error de OpenFactura tal como lo devolvió, con su detalle en `details` |

Si un documento ya se había emitido (`OF-06`), no es error: la salida trae `"yaEmitido": true` y sale `0`.

## Limitaciones

- No hay constructor para los tipos 43 (liquidación factura) y 46 (factura de compra): se emiten armando
  el DTE y usando `emitir archivo`.
- No arma descuentos o recargos globales, impuestos adicionales ni retenciones. Para eso también está
  `emitir archivo`.
- Las validaciones tributarias cubren las reglas más comunes del SII, no todas. La última palabra la tiene
  el SII al recibir el documento: revisa el estado con `documento estado`.
- OpenFactura no publica un esquema OpenAPI. El catálogo de [`docs/API.md`](docs/API.md) se armó con su
  documentación y con llamadas reales, y marca qué está verificado y qué no.

## Desarrollo

```bash
bun install
bun test               # tests unitarios, sin red
bun run typecheck
bun run test:xsd       # valida los DTE de ejemplo contra los XSD del SII (necesita Python y lxml)
bun scripts/probar-dev.ts   # emite todos los tipos contra el ambiente de pruebas
bun run build          # dist/cli.js para Node y dist/openfactura(.exe)
```

`dist/cli.js` va versionado para que se pueda instalar directo desde GitHub sin Bun. Después de
cambiar `src/`, corre `bun run build:node` y commitea el resultado: el CI falla si quedó desactualizado.

El catálogo de la API, con cada dato marcado como verificado contra la API real, documentado o inferido,
está en [`docs/API.md`](docs/API.md).

## Licencia

MIT. Hecho por [Lelemon](https://lelemon.cl). Para reportar una vulnerabilidad, mira
[SECURITY.md](SECURITY.md); para contribuir, [CONTRIBUTING.md](CONTRIBUTING.md).
