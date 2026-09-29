# Contribuir

Gracias por darte el tiempo. Issues y pull requests son bienvenidos, en español o en inglés.

## Antes de empezar

- Para un cambio grande, abre primero un issue: es más fácil acordar el enfoque antes del código.
- Un error de OpenFactura o del SII que el CLI no entiende es un buen issue. Incluye el comando, la salida
  y el `code` del error, **sin la API key ni datos de tus clientes**.

## Preparar el entorno

Necesitas [Bun](https://bun.sh) en la versión de `packageManager` en `package.json`.

```bash
bun install
bun test              # tests unitarios, sin red
bun run typecheck
bun run lint          # Biome; bun run format lo corrige
bun run test:xsd      # DTE de ejemplo contra los XSD del SII (necesita Python y lxml)
```

## Cómo se trabaja

- **El test primero.** Todo arreglo o comportamiento nuevo trae su test, y el test tiene que fallar sin el
  cambio.
- **Sin red en los tests.** Los tests simulan `fetch`. Contra la API real se prueba con
  `bun scripts/probar-dev.ts`, que usa el ambiente de pruebas y la clave demo pública.
- **Reglas del SII con su fuente.** Si agregas una validación tributaria, cita la norma (ley, resolución o
  instructivo) en el PR.
- **`dist/cli.js` va versionado.** Después de cambiar `src/`, corre `bun run build:node` y commitea el
  resultado: el CI falla si quedó desactualizado.
- **Anota el cambio en `CHANGELOG.md`**, bajo una sección `[Sin publicar]`, si afecta a quien usa el CLI.
- El código y los mensajes están en español. Sigue el estilo del archivo que tocas.

## Publicar una versión

1. Sube `version` en `package.json` y pasa `[Sin publicar]` del CHANGELOG a `[x.y.z] - AAAA-MM-DD`.
2. `bun run build:node`, commit y merge a `main`.
3. `git tag vx.y.z && git push origin vx.y.z`. El workflow `release` verifica que el tag coincida con
   `package.json`, corre todo y publica el `.tgz` con su `SHA256SUMS`.

## Conducta

Este proyecto sigue el [código de conducta](CODE_OF_CONDUCT.md).
