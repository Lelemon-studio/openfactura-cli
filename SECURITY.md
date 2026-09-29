# Seguridad

## Cómo reportar una vulnerabilidad

No abras un issue público. Repórtala en privado desde
[Security → Report a vulnerability](https://github.com/Lelemon-studio/openfactura-cli/security/advisories/new).
Contesto en un plazo de 5 días hábiles, y te aviso cuando esté arreglada y publicada.

Sirve cualquier cosa que pueda filtrar la API key, emitir un documento sin `--confirmar`, emitirlo dos
veces o mandarle al SII algo distinto de lo que mostró la salida en seco.

## Versiones con soporte

Sólo la última versión publicada en [Releases](https://github.com/Lelemon-studio/openfactura-cli/releases).

## Lo que el CLI hace con tu clave

- La lee de `OPENFACTURA_API_KEY`, `OPENFACTURA_KEY` o `--api-key`, y la manda sólo a la API de
  OpenFactura, en el header `apikey`.
- No la guarda en disco ni la muestra en la salida o en los errores: si la API la devuelve en un mensaje,
  se reemplaza antes de imprimirlo.
- No tiene dependencias en runtime ni manda datos a ningún otro servicio.
