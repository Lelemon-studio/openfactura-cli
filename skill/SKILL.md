---
name: openfactura
description: Opera OpenFactura (Haulmer) con el CLI `openfactura`: emitir facturas, boletas, notas de crédito y débito y guías de despacho ante el SII, consultar el estado de un documento, bajar su PDF o XML, listar emitidos y recibidos, ver el registro de compras y ventas del mes, y buscar la ficha de un RUT. Úsala siempre que alguien pida facturar, boletear, emitir o anular un documento tributario electrónico (DTE) en Chile, revisar si el SII aceptó un documento, o consultar ventas, compras o datos de un contribuyente con OpenFactura.
---

# OpenFactura con el CLI `openfactura`

El CLI envuelve la API de OpenFactura con las trampas ya resueltas. **Nunca armes llamadas HTTP a mano**:
si algo no está en el CLI, usa `openfactura emitir archivo` o dile al usuario que falta.

## Antes de empezar

1. Revisa que esté instalado: `openfactura --version`. Si no está, pide instalarlo (ver README del repo).
2. La API key va en la variable `OPENFACTURA_API_KEY`. **Nunca la escribas en un comando, un archivo
   versionado ni en tu respuesta.** Si falta, pídele al usuario que la configure él.
3. `openfactura emisor` confirma con qué empresa se está operando. Hazlo al principio de cada sesión y
   dile al usuario el nombre y el RUT del emisor antes de emitir nada.
4. Para probar sin consecuencias existe `--dev`, que usa el ambiente de pruebas de OpenFactura. Ahí
   sirve la clave demo pública `928e15a2d14d4a6292345f04960f4bd3`, del emisor de pruebas de Haulmer.

Todo sale en JSON por stdout. Los errores salen en JSON por stderr: código de salida `1` si los rechazó
OpenFactura o el SII, `2` si el problema está en los argumentos. `openfactura <comando> --help` tiene
todas las opciones.

## La regla que no se rompe: emitir es en seco hasta que el usuario diga que sí

Un documento emitido es evidencia tributaria y no se borra. Se corrige con otra emisión, una nota de
crédito. Por eso:

1. Corre `openfactura emitir ...` **sin** `--confirmar`. Arma el DTE, calcula los totales y no manda nada.
2. Muéstrale al usuario el `resumen`: tipo, receptor, RUT, neto, IVA, total y líneas. Muéstrale también los
   `avisos`, y el receptor completo si lo sacaste de la ficha del SII.
3. Emite con `--confirmar` sólo cuando el usuario apruebe **ese** resumen. Un "dale" dicho antes de ver
   los montos no cuenta.
4. Después revisa el estado: `openfactura documento estado --token <token>`. Recién emitido es normal ver
   `Sin estado` unos minutos. Puedes emitir con `--esperar 120` para que el CLI espere la respuesta.

Lo mismo vale para `acusar` y `anular-guia`: sin `--confirmar` sólo muestran lo que harían.

## Emitir

```bash
# Factura (33). El receptor se completa con la ficha del SII. Precio unitario NETO
openfactura emitir factura --receptor 76.430.498-5 --item "Plan mensual|1|69000"

# Precio con IVA incluido: --con-iva lo desglosa
openfactura emitir factura --receptor 76430498-5 --item "Plan anual|1|177310" --con-iva

# Varias líneas y envío del documento por correo cuando el SII lo acepte
openfactura emitir factura --receptor 76430498-5 --item "Producto|2|10000" --item "Despacho|1|3000" --correo pagos@example.com

# Factura que cita la guía de despacho y la orden de compra del cliente
openfactura emitir factura --receptor 76430498-5 --item "Producto|10|5000" --ref 52:123 --ref 801:OC-55:2026-09-01

# Boleta (39). Precio CON IVA. Sin --receptor va a consumidor final
openfactura emitir boleta --item "Producto|1|11900" --medio-pago transferencia

# Exentas: factura-exenta (34) y boleta-exenta (41), sólo para lo que la ley declara exento
openfactura emitir factura-exenta --receptor 76430498-5 --item "Arriendo oficina sin amoblar|1|500000"

# Guía de despacho (52). Desde el 1-nov-2026 exige chofer, transportista, patente y destino (Res. Ex. SII 154/2025)
openfactura emitir guia --receptor 76430498-5 --item "Caja|10|5000" --traslado venta --despacho emisor-cliente \
  --destino-direccion "Calle 1" --destino-comuna Talca --chofer-rut 11111111-1 --chofer-nombre "Juan Pérez" \
  --transportista-rut 76430498-5 --patente ABCD12

# Cualquier otro tipo (43, 46, exportación) o un DTE ya armado
openfactura emitir archivo dte.json
```

Un ítem también puede ir como JSON, útil cuando el nombre trae `|` o hace falta una descripción:
`--item '{"nombre":"Plan","cantidad":1,"precio":69000,"descripcion":"Septiembre 2026"}'`.

Los precios van **sin separador de miles**: `69000`, no `69.000`. El CLI rechaza `69.000` porque es ambiguo.

**Exento no es "lo que no lleva IVA en mi cabeza".** Sólo es exento lo que la ley declara exento (DL 825
arts. 12 y 13). Un despacho, una asesoría o un curso de una empresa normalmente llevan IVA. Si dudas,
emítelo afecto y pregúntale al usuario o a su contador antes de marcar `exento`.

### ¿Factura o boleta?

- **Factura** cuando se le vende a otra empresa o persona con giro (vendedores o prestadores de servicios),
  la pida o no (DL 825 art. 53 letra a). También siempre en la venta de inmuebles.
- **Boleta** cuando el comprador es consumidor final. El CLI se niega a emitir factura a un RUT sin giro,
  y avisa si le emites boleta a un RUT con giro.
- Si no sabes, `openfactura contribuyente <rut>`: `tieneGiro: false` significa boleta.
- Una boleta sobre 135 UF exige RUT y nombre del comprador y el medio de pago (Res. Ex. SII 44/2025): usa
  `--receptor` y `--medio-pago`. Una boleta de servicio periódico (arriendo, suscripción) es nominativa:
  `--ind-servicio 1` o `2` con `--receptor`.

### Revisa el receptor antes de confirmar

La ficha del SII a veces trae la dirección repetida, un giro largo que se recorta a 40 caracteres, o un
giro distinto del que el cliente usa en sus facturas. Si el cliente ya tiene facturas anteriores, compara
con la última (`openfactura documento json 33 <folio>`) y corrige con `--giro`, `--direccion`,
`--comuna` o `--razon-social`.

## Notas de crédito y débito

Se amarran al documento original con `--referencia <tipo>:<folio>`. El CLI lee ese documento y toma de
ahí el receptor y la fecha, y valida la nota contra él.

```bash
# Anular una factura completa: copia su detalle y sus montos
openfactura emitir nota-credito --referencia 33:30 --anula

# Rebajar parte del monto (descuento o devolución parcial) de una FACTURA. El ítem va en NETO
openfactura emitir nota-credito --referencia 33:30 --corrige-montos --razon "Descuento 50% primer mes" --item "Descuento|1|74500"

# Devolución parcial de una BOLETA. El ítem va CON IVA, como la boleta
openfactura emitir nota-credito --referencia 39:1004 --corrige-montos --razon "Devolución" --item "Devolución|1|11900"

# Corregir un dato sin tocar montos
openfactura emitir nota-credito --referencia 33:30 --corrige-texto --razon "Corrige giro del receptor"

# Nota de débito: cobrar algo que faltó
openfactura emitir nota-debito --referencia 33:30 --corrige-montos --razon "Intereses" --item "Intereses|1|5000"
```

Reglas que el CLI hace cumplir, para que no te sorprendan:

- `--anula` deja sin efecto todo el documento y no acepta `--item`. Para una parte, `--corrige-montos`.
- La nota de crédito no puede rebajar más neto, exento, IVA ni total que el documento original. El CLI no
  suma otras notas ya emitidas contra el mismo documento: revisa `openfactura emitidos --tipo 61` antes.
- El receptor es siempre el del original. **Un RUT equivocado no se corrige con `--corrige-texto`**: se
  anula el documento con `--anula` y se emite uno nuevo al RUT correcto.
- No hay nota de débito sobre boleta: se emite una boleta nueva. Una nota de crédito se revierte con una
  nota de débito, no con otra nota de crédito.

Cuándo emitirla:

- **Devolución de plata o de mercadería**: cuando la plata se restituye de verdad. Si fue un reembolso
  con tarjeta, cuando la pasarela lo dé por cursado, no cuando se solicitó. Rebaja el IVA sólo si la
  devolución ocurre dentro de 6 meses desde la entrega (DL 825 art. 21 N° 2). Fuera de ese plazo, emítela
  con `--sin-rebaja`; el CLI avisa cuando el original tiene más de 6 meses.
- **Descuento posterior sin devolución**: cuando se otorga el descuento (art. 21 N° 1). No tiene el plazo
  de 6 meses.
- Si la factura ya fue cedida (factoring), anularla afecta al cesionario: avísale al usuario antes.

## Consultar

```bash
openfactura documento estado 33 31            # ¿lo aceptó el SII?
openfactura documento pdf 33 31               # guarda el PDF (--salida para elegir el nombre)
openfactura documento xml 33 31
openfactura documento cedible 33 31           # copia cedible, para factoring
openfactura documento json 33 31              # el DTE tal como se emitió
openfactura documento estado 33 10 --rut 76430498-5   # un documento RECIBIDO: RUT de quien lo emitió

openfactura emitidos --desde 2026-09-01 --hasta 2026-09-30 --tipo 33
openfactura emitidos --tipo 33 --folio 31     # buscar un folio
openfactura emitidos --rut-receptor 76430498-5 --todas
openfactura recibidos --desde 2026-09-01 --todas

openfactura ventas 2026-09                    # resumen del mes por tipo de documento
openfactura compras 2026-09 --estado pendiente
openfactura sincronizar-rcv ventas 2026-09   # pide a OpenFactura traer el RCV del SII, si ventas o compras vienen atrasados
openfactura contribuyente 76.430.498-5        # ficha SII de un RUT
openfactura folios                            # tipos de documento autorizados
```

Para cuadrar un mes, compara `openfactura ventas AAAA-MM` con lo que dice tu propio sistema. Si
OpenFactura trae más documentos, alguien emitió por fuera.

## Errores que vas a ver

| Código | Qué significa | Qué hacer |
|---|---|---|
| `yaEmitido: true` | No es un error: ese mismo DTE ya se había enviado en las últimas 24 h y no se emitió otro. Trae el `token` si OpenFactura lo informó | Consulta el existente con ese token. **No** cambies `--idempotency-key` para forzar, salvo que el usuario quiera de verdad un segundo documento igual (dos ventas idénticas el mismo día) |
| `OF-08` | El DTE no cumple el esquema | No se consumió folio. Corrige y reintenta |
| `OF-10` | Validación de campos: montos que no cuadran, fecha, formato | El `details` dice qué campo |
| `OF-22` | No existe ese documento o folio | Revisa tipo, folio y RUT del emisor |
| `AUTH` | La API key es inválida o no está activa | Pide al usuario revisar su clave |
| `RATE_LIMIT` | OpenFactura siguió limitando después de 3 reintentos | Espera un minuto |
| `OF-429` | Límite propio de `sincronizar-rcv` | Espera los segundos de `retry_after` |
| `VALIDATION` | El CLI detectó un problema antes de enviar | Lee el mensaje: dice qué corregir |
| `TIMEOUT` al emitir | OpenFactura no respondió a tiempo, pero el documento pudo emitirse | Repite **exactamente** el mismo comando el mismo día: si ya se emitió, vuelve como `yaEmitido` |
| `RESPUESTA_INVALIDA` | OpenFactura respondió algo que no es una emisión | Igual que el timeout: repite el mismo comando |

## Lo que la API no permite

- Anular una factura o boleta: se anula con nota de crédito (`--anula`). Sólo la guía 52 se anula
  directo (`anular-guia`).
- Reenviar por correo un documento ya emitido: el envío sólo se pide al emitir (`--correo`). Después hay
  que bajar el PDF y mandarlo por otro medio.
- Webhooks, cesión de facturas, gestión de folios: no existen en la API.
