# Validación contra el esquema oficial del SII

OpenFactura no publica un OpenAPI. Su documentación remite al formato del SII, y ese formato sí tiene
esquema formal: los XSD de `sii/`, copiados sin cambios desde
https://www.sii.cl/servicios_online/3532-formato_xml-3811.html
(`factura_mercado/schema_dte.zip`, versión del 06-02-2026, y `schema_envio_bol.zip`).

`validar.py` convierte un DTE en JSON, con el formato que recibe OpenFactura, al XML del SII y lo valida
contra esos XSD. Ignora sólo lo que OpenFactura agrega al emitir: firma, timbre, fecha de firma, el atributo
`ID` y el folio real. El detalle está en el docstring del script.

`bun run test:xsd` arma con el CLI, en seco y sin red, un DTE por cada caso de `scripts/casos-xsd.ts`, y los
valida en modo `--estricto`, donde también falla si el orden de los campos no es el del XSD.

Requiere Python 3 con `lxml` (`pip install lxml`).
