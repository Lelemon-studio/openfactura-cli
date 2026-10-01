# Changelog

Los cambios que afectan a quien usa el CLI. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y las versiones, [SemVer](https://semver.org/lang/es/). Antes de la 1.0, una versión menor puede traer cambios
incompatibles, y se marcan como tales.

## [Sin publicar]

### Arreglado

- Un giro del receptor recortado a 40 caracteres ya no queda con un espacio al final.

## [0.2.0] - 2026-09-29

### Cambiado (incompatible)

- Los códigos de error que estaban en español pasan a inglés, como el resto: `ARCHIVO` → `FILE`,
  `SIN_EMISOR` → `NO_ISSUER`, `SIN_ARCHIVO` → `NO_FILE`, `ARCHIVO_INVALIDO` → `INVALID_FILE`,
  `PDF_INVALIDO` → `INVALID_PDF`, `RESPUESTA_INVALIDA` → `INVALID_RESPONSE`. La lista completa está en el README.

### Agregado

- El CLI respeta solo el límite de OpenFactura (3 llamadas por segundo, 100 por minuto). Se ajusta con
  `OPENFACTURA_LIMITE`.
- Un listado que falla a mitad de camino devuelve lo que alcanzó a bajar, con `"incompleto": true` y un aviso.
  También avisa si se corta por tope de páginas, y si `--folio` no aparece en un listado incompleto.
- Aviso cuando hay más notas de crédito previas de las que se alcanzan a revisar.
- Los DTE se arman en el orden y con los largos máximos del XSD del SII, y los tests validan contra los XSD.

### Arreglado

- Un argumento que falta o sobra se informa antes de pedir la API key.
- Si falla la lectura del documento referenciado, el error dice cuál era (`33 folio 30`).

## [0.1.0] - 2026-09-29

Primera versión pública.

[0.2.0]: https://github.com/Lelemon-studio/openfactura-cli/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Lelemon-studio/openfactura-cli/releases/tag/v0.1.0
