# OpenFactura (Haulmer): catálogo de la API REST

Catálogo de la API de OpenFactura que implementa este CLI, armado el 2026-09-27 con la documentación oficial y llamadas reales. Cada dato dice de dónde salió.

## Etiquetas

| Etiqueta | Qué significa |
|---|---|
| **[verificado]** | Comprobado contra la API real de producción, con una cuenta en uso. |
| **[verificado-dev]** | Comprobado el 2026-09-27 con llamadas de **solo lectura** a `https://dev-api.haulmer.com` usando la API key demo pública. No se emitió nada ni se tocó producción. |
| **[doc]** | Aparece en la documentación oficial (colección Postman publicada en docsapi-openfactura.haulmer.com). |
| **[SII]** | Viene del formato oficial del SII al que la doc de OpenFactura remite para los campos del DTE ("se mantienen los mismos nombres que utiliza el SII"). |
| **[inferido]** | Deducción razonable que no está escrita en ninguna fuente. |
| **[plugin]** | Visto en el código del plugin oficial `haulmer/openfactura-woocommerce`. |

## Fuentes

1. Documentación oficial: https://docsapi-openfactura.haulmer.com/ (Postman Documenter, ownerId `6074359`, publishedId `RztfvrGa`).
   La colección completa en JSON, que es la fuente primaria de este catálogo:
   `https://documenter.gw.postman.com/api/collections/6074359/RztfvrGa?segregateAuth=true&versionTag=latest`
   (3,3 MB, casi todo PDFs en base64 dentro de los ejemplos). Trae 16 requests y 2 páginas de texto.
2. Context7 `/websites/docsapi-openfactura_haulmer`: índice viejo de la misma doc, con errores (ver Contradicciones).
3. Formato DTE del SII v2.2 (2019-07-10): http://www.sii.cl/factura_electronica/factura_mercado/formato_dte.pdf
4. Formato Boletas Electrónicas del SII v4.2 (2025-09-08): https://www.sii.cl/factura_electronica/factura_mercado/formato_boleta_electronica.pdf
5. Plugin WooCommerce oficial: https://github.com/haulmer/openfactura-woocommerce/blob/master/OpenFactura.php
6. Changelog API 2.0.1 (2021): https://www.haulmer.com/articulos/changelog-api-openfactura/
7. Tutorial de la API key: https://help.haulmer.com/hc/api/como-obtengo-la-api-key-de-openfactura-aa728802-2fe2-4f3d-9bb5-2113c357ba6a
8. Resolución Ex. SII N°154/2025 (guías), notas de terceros: https://www.webfactura.cl/blog/resolucion-exenta-154-sii/ , https://sovos.com/es/blog/iva/guias-despacho-resolucion-154-sii-nuevos-requisitos-mayo-2026/

---

## 1. Generalidades

### 1.1 URLs base

| Ambiente | Host | Base efectiva | Fuente |
|---|---|---|---|
| Producción | `https://api.haulmer.com` | `https://api.haulmer.com/v2/dte` | [verificado] [doc] |
| Desarrollo | `https://dev-api.haulmer.com` | `https://dev-api.haulmer.com/v2/dte` | [verificado] [doc] |

- La doc da solo el host; todas las rutas de la colección empiezan con `{{url}}/v2/dte/...` [doc].
- Sin el prefijo `/v2/dte`, prod responde "Api no encontrada" [verificado]. En dev, `GET /organization` sin prefijo responde `404 {"statusCode":404,"message":"Resource not found"}` [verificado-dev].
- En dev los documentos usan un **CAF simulado** y el timbre no se puede validar [doc]. Desde el 03/04/2025 no existe interfaz web demo: la integración de prueba es 100% por API [doc].

### 1.2 Autenticación

- Header **`apikey: <clave>`** en todas las peticiones [verificado] [doc]. No lleva Bearer ni query param.
- La API key está atada a un **usuario-empresa**: todo lo que se hace con ella queda a nombre del "dueño" de la empresa. OpenFactura genera **una API key por contribuyente** [doc].
- Errores de autenticación (dev, hoy) [verificado-dev]:
  - Sin header: `401 { "statusCode": 401, "message": "Access denied due to missing subscription key. Make sure to include subscription key when making requests to an API." }`
  - Clave inválida: `401 { "statusCode": 401, "message": "Access denied due to invalid subscription key. Make sure to provide a valid key for an active subscription." }` (el mismo texto aparece en la doc [doc]).
  - El ejemplo "403-Autentificación-inválida" de la doc devuelve `403 {"message":"Invalid authentication credentials"}` [doc], pero hoy dev responde 401. El CLI debe tratar 401 y 403 como error de autenticación.
  - Error de permisos dentro del flujo de emisión: `OF-03` [verificado] [doc].
- La API key de producción se genera en la plataforma de OpenFactura (botón "Generar API Key") [doc].

### 1.3 Claves DEMO públicas (ambiente dev) [doc]

La doc publica dos empresas de prueba, cada una con su API key y los datos de Emisor que hay que mandar en cada emisión:

```json
{
  "apikey": "928e15a2d14d4a6292345f04960f4bd3",
  "RUTEmisor": "76795561-8",
  "RznSoc": "HAULMER SPA",
  "GiroEmis": "VENTA AL POR MENOR EN EMPRESAS DE VENTA A DISTANCIA VÍA INTERNET; COMERCIO ELEC",
  "Acteco": 479100,
  "DirOrigen": "ARTURO PRAT 527   CURICO",
  "CmnaOrigen": "Curicó",
  "CdgSIISucur": "81303347"
}
```

```json
{
  "apikey": "41eb78998d444dbaa4922c410ef14057",
  "RUTEmisor": "76430498-5",
  "RznSoc": "HOSTY SPA",
  "GiroEmis": "EMPRESAS DE SERVICIOS INTEGRALES DE INFORMÁTICA",
  "Acteco": 620200,
  "DirOrigen": "ARTURO PRAT 527 3 pis OF 1",
  "CmnaOrigen": "Curicó",
  "CdgSIISucur": "79457965"
}
```

- `GET /organization` con la primera clave devuelve `razonSocial: "HAULMER CHILE SPA"` y `rut: "76795561-8"` [verificado-dev]. La doc usa "HAULMER SPA" en el Emisor de los ejemplos; las dos formas aparecen en ejemplos que emiten bien.
- Los ejemplos de la doc usan HOSTY SPA (76430498-5) como receptor de las facturas y `66666666-6` como receptor genérico de las boletas [doc].

### 1.4 Límites

| Límite | Valor | Fuente |
|---|---|---|
| Peticiones por segundo | **3** | [doc] |
| Peticiones por minuto | **100** | [doc] |
| Respuesta al pasarse | HTTP 429. La doc muestra dos cuerpos: `{ "statusCode": 429, "message": "Rate limit is exceeded. Try again in X seconds." }` en la intro y `{"message":"API rate limit exceeded"}` en el ejemplo de emisión | [doc] |
| `registry/sync-rcv` | Límite propio por (contribuyente, tipo de registro), variable según el SII; `429 OF-429` con `retry_after` y `ends_at` | [doc] |
| Página de listados | Máximo **30 documentos** por página en `/document/issued` y `/document/received` | [doc] |
| Idempotency-Key | Vigencia de **24 h** | [doc] |
| PDF LETTER | Máximo **1 página** (restricción SII); `LETTER_80MM` pasa a 80 mm si no cabe | [doc] |
| `NmbItem` | Se trunca a 80 caracteres (antes daba error) | [doc changelog 2.0.1] |
| `DscItem` | Máximo 1000 caracteres | [doc changelog 2.0.1] |
| `GiroRecep` | Se trunca a 40 | [verificado] |
| Tamaño máximo del body | **No aparece en la doc.** | — |
| Timeout recomendado | No aparece en la doc. El plugin WooCommerce usa 30 s [plugin]. | — |
| Plazo de envío al SII | "En la mayoría de los casos no debe tomar más de 3 minutos" | [doc FAQ] |

### 1.5 Formato general de errores [doc]

```json
{
  "error": {
    "message": "Validación de Campos",
    "code": "OF-10",
    "details": [ { "field": "MntNeto", "issue": "Monto erróneo : 1000" } ]
  }
}
```

**Ojo:** algunos endpoints responden con otra forma, sin el envoltorio `error` y con `details` como objeto en vez de arreglo [verificado-dev]:

```json
{ "message": "Validación de Campos.", "code": "OF-10", "details": { "Error": "Fecha Incorrecta" } }
```

(`/registry/sales/2026/8` y `/document/issued` con un filtro mal formado.) El parser del CLI tiene que aceptar las dos formas.

Catálogo de códigos [doc]:

| Código | Descripción |
|---|---|
| OF-01 | Faltan datos obligatorios. |
| OF-02 | Faltan campos obligatorios en el dte. |
| OF-03 | Validación de permisos. [verificado: auth] |
| OF-04 | Validación de firma electrónica. |
| OF-05 | Tipo DTE no soportado. |
| OF-06 | Validación de idempotencia (la respuesta incluye el `token` del documento ya emitido). |
| OF-07 | Validación de folios. |
| OF-08 | Validación de esquema. [verificado: HTTP 400, **no consume folio**] |
| OF-09 | Validación de relaciones. |
| OF-10 | Validación de campos. [verificado: fecha/formato] |
| OF-11 | Validación de PDF. |
| OF-12 | Generación XML. |
| OF-13 | Error en DB. |
| OF-20 | Datos de entrada incorrectos. |
| OF-21 | Base de datos no disponible, intente más tarde. |
| OF-22 | Problema al procesar los datos. [verificado-dev: consultar un folio inexistente] |
| OF-23 | DTE no soportado. Bloqueo del envío de RVD (ex RCOF) y de la emisión de boletas: el usuario está emitiendo con el SII, pidió la baja, o se está corrigiendo el folio siguiente (bloqueo temporal). |
| OF-429 | Rate limit de `registry/sync-rcv` (se nombra solo en esa sección). |

Respuestas **WARNING**: una emisión válida puede traer `WARNING` (string) con reparos que no impiden emitir [doc]. Desde el 28/05/2026 las guías sin los campos nuevos de la Res. 154/2025 devuelven WARNING, y la doc anuncia que esos campos serán obligatorios más adelante [doc].

### 1.6 Historial de cambios de la doc [doc]

| Fecha | Cambio |
|---|---|
| 30/07/2026 | Nuevo `response`: `LETTER_80MM`. Validación de agentes retenedores de BERRIES según la nómina del SII. Validación informativa del tipo de dato contra el XSD. |
| 28/05/2026 | Nuevo endpoint `registry/sync-rcv`. Guías de despacho actualizadas a la Res. 154/2025 (campos nuevos opcionales por ahora, con WARNING si faltan). |
| 10/02/2026 | `MedioPago` para boletas; cambio en la regla de `RznSocRecep`. |
| 06/08/2025 | Campo `ivaExceptional` (IVA para artesanos). |
| 03/04/2025 | Se elimina la interfaz del ambiente demo. |
| 01/02/2025 | Emisión de enlaces de autoservicio por API. |
| 31/01/2025 | Campo `sendEmail` en la emisión. |
| 27/12/2024 | Filtros `FchRecepOF` y `FchRecepSII` en recibidos. |

---

## 2. Endpoints

Ruta relativa a la base `/v2/dte`. Todos llevan el header `apikey`.

| # | Método | Ruta | Para qué | Fuente |
|---|---|---|---|---|
| 1 | POST | `/document` | Emite un DTE | [verificado] [doc] |
| 1b | POST | `/issue` | Alias de emisión | [verificado]; **no está en la doc** |
| 2 | POST | `/document` (con `selfService`) | Emite un enlace de autoservicio | [doc] |
| 3 | POST | `/document/issued` | Lista emitidos (paginado, con filtros) | [verificado] [doc] |
| 4 | POST | `/document/received` | Lista recibidos (paginado, con filtros) | [verificado-dev] [doc] |
| 5 | POST | `/document/received/accuse` | Acuse de un recibido (ACD/RCD/ERM/RFP/RFT) | [doc] |
| 6 | GET | `/document/{rut}/{tipo}/{folio}/{value}` | status/json/xml/pdf/cedible por RUT, tipo y folio | [verificado] [doc] |
| 7 | GET | `/document/{token}/{value}` | status/json/xml/pdf/cedible por token | [verificado-dev] [doc] |
| 8 | GET | `/registry/sales/{yyyy}/{MM}/{dd}` | Resumen diario de ventas | [verificado-dev] [doc] |
| 9 | GET | `/registry/sales/{yyyy}/{MM}` | Resumen mensual de ventas | [verificado] [doc] |
| 10 | GET | `/registry/purchase/{yyyy}/{MM}/{dd}?status=` | Resumen diario de compras por estado | [doc] |
| 11 | GET | `/registry/purchase/{yyyy}/{MM}?status=` | Resumen mensual de compras por estado | [verificado-dev] [doc] |
| 12 | POST | `/registry/sync-rcv` | Encola una sincronización del RCV desde el SII | [doc] |
| 13 | GET | `/organization?extra_fields=logo` | Datos del emisor dueño de la key | [verificado] [doc] |
| 14 | GET | `/organization/document` | Tipos DTE autorizados y folios disponibles | [verificado] [doc] |
| 15 | GET | `/taxpayer/{rut}` | Ficha SII de cualquier contribuyente | [verificado] [doc] |
| 16 | POST | `/anularDTE52` | Anula una guía de despacho (52) | [doc] |

**No existen en la doc** (se revisaron las 18 entradas de la colección): webhooks, cesión/factoring (AEC), anulación de otros tipos que no sean la 52, gestión o subida de CAF (OpenFactura los gestiona solo, FAQ 4), reenvío de email fuera de `sendEmail`, borrar o listar enlaces de autoservicio (solo por la interfaz espacio.haulmer.com), consulta de RVD/RCOF, y links de pago. Un CLI que los ofrezca no tendría respaldo en la API documentada.

---

### 2.1 POST `/document`: emitir DTE

- **Método y ruta:** `POST {base}/v2/dte/document` [verificado] [doc]. `POST /v2/dte/issue` también emite [verificado, no documentado].
- **Headers:**

| Header | Req. | Tipo | Nota |
|---|---|---|---|
| `apikey` | * | string | |
| `Idempotency-Key` | | string | Única, la genera el cliente, dura 24 h. Si se repite dentro de ese plazo: `400 OF-06` con el `token` del documento ya emitido [doc] [verificado: soportado]. El plugin usa `WOOCOMMERCE_{rut}_{fecha}_{orderKey}` [plugin]. La doc recomienda usarla siempre en producción. |
| `Content-Type` | | `application/json` | |

- **Body** [doc]:

| Campo | Req. | Tipo | Descripción |
|---|---|---|---|
| `dte` | * | object | El DTE con la nomenclatura del SII (sección 3). Los nombres distinguen mayúsculas. |
| `response` | | array de string | Qué devolver además del TOKEN (tabla abajo). Sin él, solo vuelve `TOKEN`. |
| `custom` | | object | `informationNote` (string) y `paymentNote` (string). Salen impresos en el PDF. |
| `ivaExceptional` | | array | `["ARTESANO"]`. Solo para contribuyentes con actividad 477396. El IVA del total va en 0. Tope mensual de 5 UTM; sobre eso responde OF-10. La doc dice que va "a nivel de dte o response", pero el ejemplo lo pone en la raíz. |
| `sendEmail` | | object | `to` (string), `CC` y `BCC` (strings con correos separados por coma). Se envía **después** de que el SII acepta, además del correo de intercambio. |
| `customer`, `customizePage`, `selfService` | | object | Solo para autoservicio (2.2). |

- **Valores de `response`** [doc] [verificado: `FOLIO`, `PDF`, `XML`, `TIMBRE`]:

| Valor | Devuelve |
|---|---|
| `XML` | XML firmado en base64, codificado **ISO-8859-1** |
| `PDF` | PDF en base64 (plantilla OpenFactura) |
| `TIMBRE` | PNG del timbre (TED) en base64 |
| `LOGO` | PNG del logo de la empresa en base64 |
| `FOLIO` | Folio asignado (int) |
| `RESOLUCION` | `{ "fecha": "YYYY-MM-DD", "numero": int }` |
| `LETTER` | Formato del PDF: carta (por defecto) |
| `80MM` | Formato del PDF: rollo 80 mm |
| `80MMNOLOGO` | 80 mm sin logo |
| `LETTER_80MM` | Carta, y 80 mm si no cabe en una página (desde el 30/07/2026) |
| `SELF_SERVICE` | Solo en autoservicio: devuelve `SELF_SERVICE.url` [plugin] |

  El formato que se pida aquí (LETTER u 80MM) es el que se usa después para generar el PDF bajo demanda [doc]. Generar el PDF puede ser hasta el 60% del tiempo de emisión: si no hace falta al tiro, conviene no pedirlo [doc].

- **Respuesta 200** [doc]:

```json
{
  "TOKEN": "b3cfd2d2ea9cb6d38fa7d6f3df3c2d43eb13598aacb83c0da9580d6de629da95",
  "FOLIO": 109,
  "RESOLUCION": { "fecha": "2018-03-26", "numero": 0 },
  "TIMBRE": "<base64 png>",
  "XML": "<base64 iso-8859-1>",
  "LOGO": "<base64 png>",
  "PDF": "<base64 pdf>",
  "WARNING": "opcional"
}
```

  Que vuelva un TOKEN significa que OpenFactura recibió el documento, **no** que el SII lo aceptó. Para eso hay que consultar el status (2.6/2.7) [doc FAQ 3].

- **Errores** [doc]: `400` con el formato de 1.5 (ejemplos OF-10 de montos y OF-06 de idempotencia), `401/403` de autenticación y `429` de rate limit. OF-08 (esquema) responde 400 y no consume folio [verificado].
- **Ejemplo mínimo, factura 33 (dev)** [doc]:

```bash
curl -X POST https://dev-api.haulmer.com/v2/dte/document \
  -H 'apikey: 928e15a2d14d4a6292345f04960f4bd3' \
  -H 'Idempotency-Key: pedido-1234' \
  -H 'Content-Type: application/json' \
  -d '{"response":["FOLIO"],"dte":{"Encabezado":{"IdDoc":{"TipoDTE":33,"Folio":0,"FchEmis":"2026-09-27","TpoTranVenta":1,"FmaPago":1},"Emisor":{"RUTEmisor":"76795561-8","RznSoc":"HAULMER SPA","GiroEmis":"VENTA AL POR MENOR POR CORREO, POR INTERNET Y VIA TELEFONICA","Acteco":479100,"DirOrigen":"ARTURO PRAT 527 CURICO","CmnaOrigen":"Curicó","CdgSIISucur":"81303347"},"Receptor":{"RUTRecep":"76430498-5","RznSocRecep":"HOSTY SPA","GiroRecep":"ACTIVIDADES DE CONSULTORIA DE INFORMATIC","DirRecep":"ARTURO PRAT 527","CmnaRecep":"Curicó"},"Totales":{"MntNeto":2000,"TasaIVA":"19","IVA":380,"MntTotal":2380}},"Detalle":[{"NroLinDet":1,"NmbItem":"item","QtyItem":1,"PrcItem":2000,"MontoItem":2000}]}}'
```

  (Body de ejemplo, no ejecutado en esta investigación.) El body de emisión que se verificó tiene la forma `{"response":["FOLIO"], "dte": {...}}` [verificado].

### 2.2 POST `/document` con autoservicio [doc]

Misma ruta y headers que 2.1. Genera un **enlace** para que el cliente final emita su propia boleta o factura. Campos adicionales:

| Campo | Req. | Tipo | Descripción |
|---|---|---|---|
| `selfService` | * | object | `issueBoleta` (bool: emitir la boleta de inmediato), `allowFactura` (bool: el cliente puede convertirla en factura), `documentReference` (`type` string, p. ej. `"801"`; `id` number; `date` `YYYY-MM-DD`) |
| `customer` | | object | `fullName`, `email` (se usan en el correo y en la interfaz) |
| `customizePage` | | object | `externalReference { hyperlinkText, hyperlinkURL }`, `urlLogo` |
| `response` | | array | Agregar `"SELF_SERVICE"` |

- En `dte.Encabezado.IdDoc`, `TipoDTE` y `Folio` **no son obligatorios** [doc].
- El DTE se valida siempre, aunque no se emita la boleta [doc].
- Reglas de fecha con `FchEmis` en enero: si `issueBoleta=true` y el cliente la convierte en factura dentro de los primeros 10 días de febrero, la factura queda con fecha de enero; si lo hace después, queda con la fecha actual. Si `issueBoleta=false`, siempre queda con la fecha de enero [doc].
- Cuando el cliente emite la factura, OpenFactura **anula la boleta con una nota de crédito automáticamente** [doc].
- Respuesta: igual que 2.1, más `SELF_SERVICE: { "url": "..." }` [plugin]. La doc no documenta la forma de `SELF_SERVICE`.
- El plugin manda `documentReference` como **arreglo** de objetos con la clave `ID` en mayúscula, mientras la doc lo muestra como objeto con `id` [plugin vs doc]. No se verificó cuál acepta la API.

### 2.3 POST `/document/issued`: listar emitidos

**No emite.** Lista [verificado] [doc]. (Context7 dice que emite, y es falso.)

- Body: filtros, todos opcionales. Sin filtros devuelve todo [doc].

| Filtro | Tipo | Nota |
|---|---|---|
| `RUTRecep` | int (sin DV) | La doc lo describe como "Rut emisor" por error: es el receptor |
| `FchEmis` | string `YYYY-MM-DD` | |
| `TipoDTE` | int | Ver nota abajo |
| `Page` | string o int | Número de página |

- Operadores de cada filtro: `eq`, `lt`, `gt`, `lte`, `gte`, `ne`; se pueden combinar, p. ej. `{"FchEmis":{"gte":"2025-01-01","lte":"2025-04-11"}}` [doc] [verificado-dev].
- **`TipoDTE` va con operador: `{"TipoDTE":{"eq":39}}`** [verificado en prod el 2026-09-27]. La forma de arreglo
  `{"TipoDTE":[39]}`, que funcionó en ago-2026, hoy responde `400 OF-10 "Operador no encontrado"`. El operador
  `in` tampoco existe: `{"TipoDTE":{"in":[33,61]}}` da `400 OF-10 "debe ser un número"`.
- 🔴 **Un filtro que el endpoint no conoce se ignora en silencio** [verificado en prod el 2026-09-27]:
  `{"Folio":{"eq":31},"TipoDTE":{"eq":33}}` devuelve las 16 facturas, no la 31. Filtrar por un campo no listado
  arriba da un resultado que parece correcto y no lo es. El CLI sólo acepta los filtros documentados.
- Respuesta 200 [doc] [verificado-dev]:

```json
{
  "current_page": 1,
  "last_page": 251,
  "data": [
    { "RUTRecep": 66666666, "DV": "6", "RznSocRecep": null, "TipoDTE": 39, "Folio": 674176,
      "FchEmis": "2026-09-27", "FechaRecibido": "2026-09-27 13:48:29.0929",
      "MntExe": 0, "MntNeto": 2521, "IVA": 479, "MntTotal": 3000, "FmaPago": 0,
      "Token": "9be8d4d4..." }
  ],
  "total": "<int>"
}
```

  La doc llama al campo `token` en minúscula; dev lo devuelve como **`Token`** [verificado-dev].
- Sin resultados: **204 con cuerpo vacío** [verificado] [verificado-dev].
- Error de filtro: 400 OF-10 (forma sin envoltorio `error`) [verificado-dev].

### 2.4 POST `/document/received`: listar recibidos [doc] [verificado-dev]

- Filtros: `RUTEmisor` (int), `FchEmis`, `TipoDTE` (int), `FchRecepOF` y `FchRecepSII` (`YYYY-MM-DD`), `Page`. Mismos operadores que 2.3.
- `FchRecepSII` puede venir vacío al principio, porque OpenFactura la trae del SII en un proceso aparte. `FchRecepOF` siempre viene. Sirven para detectar documentos que llegan con fecha de emisión atrasada [doc].
- Respuesta: `current_page`, `last_page`, `total` y `data[]` con `RUTEmisor` (int), `DV`, `RznSoc`, `TipoDTE`, `Folio`, `FchEmis`, `FchRecepSII`, `FchRecepOF`, `MntExe`, `MntNeto`, `IVA`, `MntTotal`, `Acuses` (arreglo de `{codEvento, fechaEvento, estado}` o `null`), `FmaPago`, `TpoTranCompra` [doc] [verificado-dev].
- `FmaPago`: 1 Contado, 2 Crédito, 3 Sin costo. En dev aparece `0` cuando no viene informado [verificado-dev].
- `TpoTranCompra`: 1 Del giro, 2 Supermercados, 3 Bien raíz, 4 Activo fijo, 5 IVA uso común, 6 Sin derecho a crédito, 7 No corresponde incluir [doc].
- 30 por página [doc].

### 2.5 POST `/document/received/accuse`: acusar un recibido [doc]

- Body: `{"dte":33,"folio":2514,"rut":"76795561-8","acuse":"ACD"}`

| Campo | Req. | Tipo | Nota |
|---|---|---|---|
| `rut` | * | string | RUT del **emisor** del documento recibido, con DV |
| `dte` | * | int | Tipo |
| `folio` | * | int | |
| `acuse` | * | string | La tabla de la doc dice int, pero el ejemplo y los valores son string |

- Valores de `acuse`: `ACD` acepta el contenido; `RCD` reclama el contenido; `ERM` otorga recibo de mercaderías o servicios; `RFP` reclamo por falta parcial; `RFT` reclamo por falta total.
- Respuesta (solo tabla, la doc no trae ejemplo): `data[] {dte, folio, acuse}`, `code` (int), `result` (string), `msg[] {codResp:int, descResp:string}`.
- Escribe en el SII: **no se probó**.

### 2.6 GET `/document/{rut}/{tipo}/{folio}/{value}` [verificado] [doc]

- Parámetros: `rut` del **emisor** (con DV), `tipo` (int), `folio` (int), `value` ∈ `status | json | xml | pdf | cedible`.
- Sirve para emitidos y **también para recibidos** [doc].
- Respuestas:
  - `status` → `{"estado":"Aceptado","folio":"674180"}` [verificado-dev]. Valores de `estado`:
    - Emitidos [doc]: `Aceptado`, `Pendiente`, `Rechazado`, `Aceptado con Reparo`. Además `Sin estado` [verificado], que la doc no menciona.
    - Recibidos [doc]: `Pendiente`, `Registrado`, `No_incluir`, `Reclamado`. Pasa a `Registrado` sola después de 8 días en Pendiente.
  - `json` → `{"json":{...DTE...},"folio":26005,"FchRecepSII":"...","FchRecepOF":"..."}` [verificado] [doc]. En el ejemplo de la doc los valores numéricos del DTE vienen como string.
  - `pdf` → `{"pdf":"<base64>","folio":...}` [verificado]. Si no se pidió en la emisión, se genera en ese momento con el formato que se pidió entonces [doc].
  - `xml` → `{"xml":"<base64>"}` [doc].
  - `cedible` → copia cedible en PDF base64 [doc]. Si el documento no tiene cedible (p. ej. una boleta): `400 OF-10 {"field":"Documento","issue":"Documento sin cedible"}` [verificado-dev].
- Errores [verificado-dev]:
  - `value` inválido: `400 OF-10 {"field":"Error","issue":"foo es Incorrecto"}`.
  - Folio inexistente: `400 OF-22 "Problema al procesar los datos"` con details `problema / dte / folio`.

### 2.7 GET `/document/{token}/{value}` [doc] [verificado-dev]

- Igual que 2.6, usando el `TOKEN` de la emisión. Solo para **emitidos** [doc].
- Respuestas: `{"estado":"Aceptado","token":"..."}`, `{"json":{...},"token":"...","FchRecepSII":"","FchRecepOF":"2025-04-11 23:00:27.0427"}`, `{"xml":"...","token":"..."}` y `{"pdf":"...","folio":600625}`.

### 2.8 y 2.9 GET `/registry/sales/{yyyy}/{MM}[/{dd}]` [verificado] [doc]

- El mes **lleva cero a la izquierda**: `/registry/sales/2026/8` → `400 {"message":"Validación de Campos.","code":"OF-10","details":{"Error":"Fecha Incorrecta"}}` [verificado] [verificado-dev]. La doc dice "int" sin aclararlo.
- Respuesta:

```json
{ "fechaInicio": "2026-08-01", "fechaFinal": "2026-08-31",
  "registros": [ { "tipoDocumento": 33, "cantDocumentos": 20, "totalMntExe": 0, "totalMntNeto": 1615489,
                   "totalMntIVA": 306943, "totalOtrosImp": 0, "totalMntTotal": 1922431 } ] }
```

  Aparecen también los tipos de referencia `801` y `802` con montos en cero [doc] [verificado-dev]. `totalOtrosImp` existe aunque la tabla de la doc no lo menciona.

### 2.10 y 2.11 GET `/registry/purchase/{yyyy}/{MM}[/{dd}]?status=` [doc] [verificado-dev]

- Query `status` (opcional): lista separada por coma con `pending`, `registered`, `exclude`, `reclaimed`. Sin él vienen todos.
- Respuesta: **arreglo**, un objeto por estado: `[{ "estado": "Pendiente", "fechaInicio", "fechaFinal", "registros": [...] }]`.
- Nombres de `estado` que devuelve: la doc dice `Pendiente`, `Registrado`, `No_incluir`, `Reclamado`; dev devuelve **`Registro`** (no "Registrado"), `Pendiente`, `No_incluir`, `Reclamado` [verificado-dev].

### 2.12 POST `/registry/sync-rcv` [doc]

- Pide que OpenFactura sincronice el RCV del SII. La solicitud queda **encolada**; no devuelve datos.
- Body: `{"registro":"sales"|"purchase","periodo":202605}` (`periodo` int `YYYYMM`).
- Restricciones:
  - Rate limit por (contribuyente, registro), dinámico según el SII. Al pasarse: `429 OF-429` con `retry_after` (segundos) y `ends_at` (fin del bloqueo).
  - `periodo` no puede pasar del período actual + 2 meses. Si pasa: `400 OF-10`.
  - Hay que respetar `retry_after`, guardar `ends_at` y manejar `sales` y `purchase` por separado.
- Respuesta: `{ "message": string, "code": string }` según la tabla. Los dos ejemplos de la doc ("OK" y "Error de registro" con `"registro":"compra"`) vienen con el cuerpo vacío, así que la forma real no está documentada.
- No se probó, porque dispara un proceso contra el SII.

### 2.13 GET `/organization` [verificado] [doc] [verificado-dev]

- Query `extra_fields=logo` (hoy es el único valor posible) [doc]. En dev, con `extra_fields=logo` la respuesta visible no traía un campo logo en los primeros 600 caracteres; no se revisó el resto.
- Respuesta: `rut`, `razonSocial`, `email`, `telefono`, `direccion`, `cdgSIISucur`, `glosaDescriptiva` (giro), `direccionRegional`, `comuna`, `ciudad`, `resolucion {fecha, numero}`, `nombreFantasia`, `web`, `sucursales[]`, `actividades[] {giro, actividadEconomica, codigoActividadEconomica (string), actividadPrincipal}`.
- Para armar el Emisor: `RznSoc` = `razonSocial`, `GiroEmis` = `glosaDescriptiva` o `actividades[].giro`, `Acteco` = `codigoActividadEconomica`, `CdgSIISucur` = `cdgSIISucur` [inferido].

### 2.14 GET `/organization/document` [verificado] [doc]

- Respuesta: `{"rut":"76795561-8","documentos":[{"dte":33,"disponibles":304938,"vencimiento":"2027-03-01"}, ...]}` [verificado-dev].
- La tabla de la doc dice `disponible`, pero el campo real es **`disponibles`**.
- **No confiable** [verificado].
- Es un GET sin body. Context7 lo muestra como POST con `{"rut":...}`, y es falso.

### 2.15 GET `/taxpayer/{rut}` [verificado] [doc]

- `rut` con DV y guion.
- Respuesta: `rut`, `razonSocial`, `email`, `telefono`, `direccion`, `comuna`, `actividades[]`, `sucursales[] {cdgSIISucur, comuna, direccion, ciudad, telefono}`.
- RUT inexistente: **200 con nulls** [verificado]. Ojo: un RUT existente en el SII pero sin giro también trae `actividades[0]` con todo en null (`11111111-1` en dev) [verificado-dev]. El CLI debe distinguir "no existe" de "existe sin actividad".

### 2.16 POST `/anularDTE52`: anular guía de despacho [doc]

- Body del ejemplo: `{"Dte": 52,"Folio": 34972,"Fecha": "2020-10-16"}`. La tabla escribe `dte` y `folio` en minúscula; el ejemplo va en mayúscula inicial. Usar la forma del ejemplo [inferido].
- Valida que el documento no se anule dos veces.
- Respuesta 200: `{"success":"Se ha anulado el documento Folio: 34972"}` (la tabla dice `succes`).
- Error: formato 1.5, p. ej. `OF-10`.
- No se probó.

---

## 3. Esquema del DTE (`dte`) para emitir

OpenFactura usa los mismos nombres y la misma jerarquía que el XML del SII, en JSON [doc]. La doc advierte que muestra "solo un subconjunto": para la lista completa remite al formato del SII. Todo lo que diga [SII] sale de ahí.

### 3.1 Estructura y orden [doc]

El orden de las secciones importa:

```
dte
├── Encabezado *        { IdDoc*, Emisor*, RUTMandante, Receptor*, RUTSolicita, Transporte, Totales* }
├── Detalle *           [ ... ]   (límite de líneas: no documentado por OpenFactura)
├── DscRcgGlobal        [ ... ]   (hasta 20)
├── Referencia          [ ... ]   (hasta 40)
└── Comisiones          [ ... ]   (hasta 20; obligatoria en 43)
```

### 3.2 Tabla genérica de la doc [doc]

**IdDoc**

| Campo | Req. | Tipo | Regla |
|---|---|---|---|
| TipoDTE | * | int | |
| Folio | * | int | **Debe ser 0**: OpenFactura asigna el folio |
| FchEmis | * | string | AAAA-MM-DD |
| TpoTranCompra | | int | |
| TpoTranVenta | | int | |
| FmaPago | | int | |
| MedioPago | | int | Solo boletas: obligatorio si el total supera 135 UF |

**Emisor (DTE no boleta)**: `RUTEmisor`*, `RznSoc`*, `GiroEmis`*, `CorreoEmisor`, `Acteco`* (int; también sirve un arreglo, como se ve en el `json` devuelto), `DirOrigen`*, `CmnaOrigen`*. Los ejemplos agregan `CdgSIISucur` y `Telefono`.

**Receptor**: `RUTRecep`*, `RznSocRecep`* (obligatorio en boleta si supera 135 UF), `GiroRecep`*, `Contacto`*, `DirRecep`*, `CmnaRecep`*. En la práctica `Contacto` se omite en varios ejemplos que emiten bien [doc], y la boleta no lleva `GiroRecep` [verificado].

**Detalle**: `NroLinDet`* (secuencial), `NmbItem`*, `DscItem`, `QtyItem`* (float, hasta 6 decimales), `PrcItem`* (float, hasta 6 decimales), `MontoItem`* (int), `IndExe` (exento o no facturable).

**DscRcgGlobal**: `NroLinDR`*, `TpoMov`* (`D` o `R`), `GlosaDR` (hasta 45 [SII]; sale en el PDF [changelog]), `TpoValor`* (`%` o `$`), `ValorDR`*, `IndExeDR` (1 exento, 2 no facturable).

**Totales**: `MntNeto`, `MntExe`, `IVA`, `MntTotal`*, `MntNF`, `SaldoAnterior`, `VlrPagar`. Los ejemplos agregan `TasaIVA` ("19") y `MontoPeriodo` (en boletas, `TotalPeriodo`).

OpenFactura **recalcula y valida los montos**. Un descuadre da `OF-10` con el monto esperado en `issue`, p. ej. `"Monto erróneo : 1000"` [doc].

### 3.3 Por tipo de documento

Tipos que OpenFactura soporta: la doc lista **33, 34, 38, 39, 41, 43, 46, 52, 56, 61** [doc]. `/organization/document` del demo devuelve folios para 33, 34, 39, 41, 43, 46, 52, 56 y 61 [verificado-dev].
**Exportación (110, 111, 112): la doc de OpenFactura no los menciona**. No hay ejemplos ni folios en el demo. Lo esperable es `OF-05 Tipo Dte no soportado` [inferido, no probado]. La 38 aparece en la tabla de códigos, pero no hay ejemplo ni folios en el demo.

#### 33 Factura electrónica (afecta) [doc] [verificado]
- IdDoc: `TipoDTE:33, Folio:0, FchEmis`; opcionales `TpoTranCompra`, `TpoTranVenta`, `FmaPago` (el SII lo exige y asume 2 si falta [SII]).
- Emisor completo con `Acteco`. Receptor completo con `GiroRecep` (se trunca a 40 [verificado]).
- Totales: `MntNeto`, `TasaIVA:"19"`, `IVA`, `MntTotal`; `MntExe` si hay líneas exentas.
- **Detalle en montos NETOS** [verificado].
- Si todas las líneas son `IndExe:1`, tiene que ser una 34 [SII].

#### 34 Factura no afecta o exenta [doc]
- Como la 33, pero Totales solo con `MntExe` y `MntTotal`, sin IVA ni TasaIVA. Los ítems del ejemplo llevan `IndExe:1`.

#### 39 Boleta electrónica [verificado] [doc]
- IdDoc: `TipoDTE:39, Folio:0, FchEmis, IndServicio` (**obligatorio**, normalmente `3`) [verificado]. `MedioPago` es obligatorio si el total supera 135 UF (Ley 21.713) [doc] [SII].
- **Emisor: `RznSocEmisor` y `GiroEmisor`, sin `Acteco`** [verificado]; más `CdgSIISucur`, `DirOrigen`, `CmnaOrigen`.
- Receptor: `RUTRecep` (genérico `66666666-6`), **sin `GiroRecep`** [verificado]. `RznSocRecep` es obligatorio si supera 135 UF o si `IndServicio=3` con RUT 0 [SII].
- Totales: `MntNeto`, `IVA`, `MntTotal`, `TotalPeriodo`, `VlrPagar`, **sin `TasaIVA`** [verificado].
- **Detalle en montos BRUTOS** (con IVA incluido) [verificado]. `IndMntNeto=2` indica líneas netas [SII], pero no se probó en OpenFactura.
- Un em-dash en `NmbItem` se borra [verificado].

#### 41 Boleta exenta electrónica [doc]
- Igual que la 39, con Totales `MntExe`, `MntTotal`, `TotalPeriodo`, `VlrPagar` y líneas con `IndExe:1`.

#### 43 Liquidación-factura [doc]
- Como la 33; cada línea lleva `TpoDocLiq` (p. ej. `"33"`) [doc]. La sección `Comisiones` es obligatoria según el SII [SII]: `NroLinCom`, `TipoMovim` (`C` u `O`), `Glosa`, `TasaComision`, `ValComNeto`, `ValComExe`, `ValComIVA`. La doc de OpenFactura no trae un ejemplo con Comisiones.

#### 46 Factura de compra [inferido de SII]
- Sin ejemplo en la doc. Se sabe que está soportada porque el demo tiene folios. Según el SII, el emisor es el comprador y retiene el IVA (`CodImpAdic` de retención en `ImptoReten` / `OtrosImp`). **No documentado en OpenFactura.**

#### 52 Guía de despacho [doc]
- IdDoc: `TipoDespacho` (opcional) e **`IndTraslado`** (obligatorio en guías) [SII].
- El ejemplo pone `GuiaExport: {CdgTraslado:"3"}` dentro de Emisor y un objeto `Transporte: {DirDest, CmnaDest, CiudadDest}` en Encabezado.
- Res. 154/2025 (vigente desde el 1/11/2026 [externo]): campos nuevos de transporte (chofer, patente, `PatenteCarro`, origen y destino, fecha estimada de entrega). **OpenFactura no lista cuáles son**: solo dice que por ahora son opcionales, que dan WARNING si faltan y que serán obligatorios. Consultar el Anexo Técnico SII v2.5.
- Se anula con `POST /anularDTE52`.

#### 56 Nota de débito [doc]
- Como la 33, más `Referencia` obligatoria.

#### 61 Nota de crédito [verificado] [doc]
- Como la 33, más `Referencia`: `[{NroLinRef, TpoDocRef:"33", FolioRef, FchRef, CodRef:1|2|3, RazonRef}]` [verificado: emitida y aceptada].
- `IndNoRebaja: 1` para una nota de crédito sin derecho a rebajar el débito [SII].
- **CodRef 2 (corrige texto):** según la práctica SII, los montos van en 0 y la corrección se describe en el detalle o en `RazonRef` [SII/inferido]. No hay ejemplo en OpenFactura.
- Para anular una boleta con NC, referenciar `TpoDocRef:"39"` [inferido; OpenFactura lo hace internamente en el autoservicio].

#### 110, 111, 112 Exportación
- **No documentados en OpenFactura** (ver arriba). Solo existe el formato SII: `IndServicio` 1 a 5, `FmaPagExp`, `Transporte.Aduana`, `OtraMoneda`, `TpoMoneda`, etc.

### 3.4 Valores válidos de códigos

| Campo | Valores | Fuente |
|---|---|---|
| `TipoDTE` | 33, 34, 38, 39, 41, 43, 46, 52, 56, 61 (OpenFactura); 110, 111, 112 existen en el SII | [doc] [SII] |
| `IndServicio` (boleta) | 1 servicios periódicos; 2 servicios periódicos domiciliarios; **3 venta y servicios**; 4 espectáculo por cuenta de terceros | [SII boletas v4.2] |
| `IndServicio` (factura) | 1 servicios periódicos domiciliarios; 2 otros servicios periódicos; 3 servicios; exportación: 4 hotelería, 5 transporte terrestre internacional | [SII] |
| `FmaPago` | 1 contado; 2 crédito (valor por defecto); 3 sin costo (entrega gratuita, sin crédito fiscal) | [doc] [SII] |
| `MedioPago` (boleta) | 1 efectivo; 2 pago electrónico; 3 transferencia; 4 cheque; 5 otro | [SII boletas v4.2] |
| `MedioPago` (factura) | `CH` cheque; `CF` cheque a fecha; `LT` letra; `EF` efectivo; `PE` pago a cta. cte.; `TC` tarjeta de crédito; `OT` otro | [SII] |
| `TpoTranVenta` | 1 ventas del giro (por defecto); 2 venta activo fijo; 3 venta bien raíz | [SII] |
| `TpoTranCompra` | 1 giro; 2 supermercados; 3 bien raíz; 4 activo fijo; 5 IVA uso común; 6 sin derecho a crédito; 7 no corresponde incluir | [doc] [SII] |
| `IndTraslado` (52) | 1 venta; 2 ventas por efectuar; 3 consignaciones; 4 entrega gratuita; 5 traslados internos; 6 otros traslados no venta; 7 guía de devolución; 8 traslado para exportación (no venta); 9 venta para exportación | [SII] |
| `TipoDespacho` | 1 por cuenta del receptor; 2 por cuenta del emisor a instalaciones del cliente; 3 por cuenta del emisor a otras instalaciones | [SII] |
| `CdgTraslado` (`GuiaExport`, 52) | 1 exportador; 2 agente de aduana; 3 vendedor; 4 contribuyente autorizado por el SII (con `FolioAut`). Obligatorio si `IndTraslado` es 8 o 9 | [SII] |
| `IndExe` (detalle) | 1 no afecto o exento; 2 no facturable; 3 garantía por envases; 4 ítem no venta (facturas y guías) | [SII] |
| `IndExeDR` | 1 exento; 2 no facturable | [doc] [SII] |
| `TpoMov` / `TpoValor` | `D` / `R` ; `%` / `$` | [doc] |
| `CodRef` | 1 anula el documento de referencia; 2 corrige texto; 3 corrige montos. Los casos 1 y 2 llevan una sola referencia | [SII] [verificado] |
| `TpoDocRef` | 30, 32, 33, 34, 35, 38, 39, 40, 41, 43, 45, 46, 50, 52, 55, 56, 60, 61, 103, 110, 111, 112; no tributarios 801 OC, 802 nota de pedido, 803 contrato, 804 resolución, 805 proceso ChileCompra, 806 ficha ChileCompra, 807 DUS, 808 B/L, 809 AWB, 810 MIC/DTA, 811 carta de porte, 812 resolución SNA, 813 pasaporte, 814 y 815 Bolsa de Productos, 820 registro de plazo de pago excepcional. Con un valor alfabético el SII no valida | [SII] |
| `IndGlobal` (Referencia) | 1 = referencia a más de 20 documentos (en ese caso `FolioRef` va en 0) | [SII] |
| `IndNoRebaja` (61) | 1 | [SII] |
| `TpoImpresion` | `N` normal / `T` ticket | [SII] |
| `TipoMovim` (Comisiones) | `C` comisión / `O` otros cargos | [SII] |

### 3.5 Validaciones propias de OpenFactura

| Comportamiento | Fuente |
|---|---|
| `Folio` siempre 0 | [doc] |
| `GiroRecep` se trunca a 40 | [verificado] |
| `NmbItem` se trunca a 80 | [doc changelog] |
| El em-dash en `NmbItem` se elimina | [verificado] |
| Rechazo de esquema OF-08 (HTTP 400) no consume folio | [verificado] |
| Montos recalculados; un descuadre da OF-10 con el valor esperado | [doc] |
| Retención BERRIES validada contra la nómina del SII (desde el 30/07/2026) | [doc] |
| Tipo de dato validado contra el XSD, en modo informativo (WARNING) | [doc] |
| El XML devuelto viene en ISO-8859-1 | [doc] |
| En el `json` devuelto, las tildes pueden venir como mojibake (`CuricÃ³`) | [doc, en el ejemplo] |

---

## 4. Contradicciones entre fuentes

| # | Tema | Una fuente dice | La otra dice | Qué hacer |
|---|---|---|---|---|
| 1 | `POST /document/issued` | Context7: "Issues a DTE" | [verificado] y doc oficial: **lista** emitidos. Emitir es `POST /document` | Ignorar Context7 |
| 2 | `/organization/document` | Context7: POST con body `{"rut":...}` | Doc oficial y dev: **GET sin body** | GET |
| 3 | Campo de folios | Tabla de la doc: `disponible` | Respuesta real: `disponibles` | `disponibles` |
| 4 | Filtro `TipoDTE` en issued | [verificado]: arreglo `[39]` | Doc: `{"eq":"33"}`. Dev hoy: arreglo → OF-10 "Operador no encontrado"; `{"eq":39}` → 200 | **Volver a medir en prod.** Preferir la forma operador y reintentar con arreglo |
| 5 | Token en el listado de emitidos | Doc: `token` | Dev: `Token` | Leer los dos |
| 6 | Valores de status | Doc: 4 estados (Aceptado, Pendiente, Rechazado, Aceptado con Reparo) | [verificado]: también `Sin estado` | Tratar `Sin estado` como no enviado o desconocido |
| 7 | Estado de compras | Doc: `Registrado` | Dev: `Registro` | Aceptar las dos |
| 8 | Clave inválida | Ejemplo de la doc: 403 "Invalid authentication credentials" | Intro de la doc y dev: 401 "invalid subscription key" | 401 y 403 = auth |
| 9 | Cuerpo del 429 | Intro: `{statusCode, message:"Rate limit is exceeded. Try again in X seconds."}` | Ejemplo: `{"message":"API rate limit exceeded"}` | Parsear los dos; sacar los segundos del texto si vienen |
| 10 | Forma del error | Doc: `{error:{message,code,details[]}}` | Dev (registry, issued): `{message,code,details:{}}` sin envoltorio | Parser tolerante |
| 11 | Emisor en boleta | Tabla genérica de la doc: `RznSoc`/`GiroEmis`/`Acteco` obligatorios | [verificado] y ejemplos de boleta: `RznSocEmisor`/`GiroEmisor`, sin Acteco | Esquema distinto por tipo |
| 12 | Receptor | Tabla genérica: `GiroRecep` y `Contacto` obligatorios | [verificado]: la boleta no lleva GiroRecep. Varios ejemplos de factura omiten Contacto | No forzar Contacto |
| 13 | `TasaIVA` | Ejemplos de factura: sí lo llevan | [verificado]: la boleta no lo lleva | Solo en no-boletas |
| 14 | Mes en registry | Doc: `month` int | [verificado] y dev: tiene que ir con cero a la izquierda (`08`) | Formatear con 2 dígitos |
| 15 | Campo `acuse` | Tabla: int | Ejemplo y valores: string (`"ACD"`) | string |
| 16 | `anularDTE52` | Tabla: `dte`, `folio`, `Fecha`; respuesta `succes` | Ejemplo: `Dte`, `Folio`, `Fecha`; respuesta `success` | Usar la forma del ejemplo |
| 17 | `documentReference` del autoservicio | Doc: objeto `{type,id,date}` | Plugin oficial: arreglo `[{type,ID,date}]` | No verificado |
| 18 | `RUTRecep` en issued | Doc: "Rut emisor" | Es el receptor (lo confirman la respuesta y el nombre) | Receptor |
| 19 | Ruta sin `/v2/dte` | [verificado] prod: "Api no encontrada" | Dev: `404 "Resource not found"` | Mismo efecto |
| 20 | Nombre del emisor demo | Doc: "HAULMER SPA" | `/organization`: "HAULMER CHILE SPA" | Los dos emiten en los ejemplos |
| 21 | Índice de Context7 | Le faltan `/registry/sync-rcv` y el autoservicio | Doc actual sí los tiene | Context7 está desactualizado |

## 5. Lo que no está documentado

Para no inventarlo en el CLI:

- Tamaño máximo del body y de la respuesta; timeouts.
- La forma de la respuesta de `/document/received/accuse` y de `/registry/sync-rcv` (solo hay tablas, sin ejemplos reales).
- La forma de `SELF_SERVICE` en la respuesta (solo se conoce `url`, por el plugin).
- Esquemas de 46 y 43 con Comisiones, y de exportación 110/111/112 (sin ejemplo; exportación probablemente no soportada).
- Los campos exactos de la Res. 154/2025 que OpenFactura acepta para la 52.
- Paginación de `/document/received` más allá de `Page`; no hay parámetro de tamaño de página.
- Webhooks o callbacks, cesión (AEC), anulación de otros tipos, RVD, CAF, borrar enlaces de autoservicio.
- La semántica exacta de `extra_fields=logo` en la respuesta de `/organization`.
- La razón de que `/organization/document` sea "no confiable" [verificado]; la doc no dice nada al respecto.
