# Bancada para Mac

Este proyecto es la versión de macOS de Bancada. Comparte el código con la de
Windows (`main.js`, `preload.js`, `src/`): lo que cambia es cómo se empaqueta, se
firma y se entrega. No hace falta tener una Mac: se compila, se firma con
Developer ID y se notariza en un runner de macOS de GitHub Actions.

El detalle paso a paso, con los secretos y las dos corridas, está en
[`COMO FIRMAR EN MAC.md`](COMO%20FIRMAR%20EN%20MAC.md).

## El flujo, en cinco pasos

1. **Trabajás el código en la máquina de desarrollo.** Windows y Mac usan los
   mismos archivos: todo lo que es de una sola plataforma está detrás de un
   chequeo de plataforma, así que lo de Windows sigue andando igual.
2. **Cifrás el código** (`npm run contenido:cifrar`). El repositorio es público,
   así que `main.js`, `preload.js` y `src/` no se suben en claro: se sube
   `contenido-cifrado/app.mfenc`.
3. **Subís al repositorio.** Los originales están en el `.gitignore`.
4. **Corrés el workflow `Compilar para Mac`** desde la pestaña Actions. Descifra,
   corre las pruebas, compila los dos `.dmg` (Apple Silicon e Intel), los firma,
   los notariza y los sube sellados.
5. **Bajás el artefacto y lo abrís** con
   `node scripts/contenido-cifrado.mjs abrir bancada-mac-entrega.mfenc .`
   (el punto es la carpeta actual: el paquete ya trae adentro la carpeta
   `Entrega Mac`, así que queda `Entrega Mac/` al lado de la entrega de Windows).
   El build de prueba trae `bancada-mac-prueba/`. La guía del comprador no viaja
   en el repositorio: se queda en tu máquina dentro de `Entrega Mac/`, y abrir el
   artefacto no la borra.

## Comandos

| Comando | Para qué |
|---|---|
| `npm start` | abrir el programa en desarrollo |
| `npm test` | las 14 pruebas unitarias |
| `npm run contenido:cifrar` | volver a cifrar el código después de tocarlo |
| `npm run contenido:verificar` | comprobar que el cifrado está al día |
| `npm run build:win` | compilar Windows (corta si el cifrado quedó viejo) |
| `npm run build:mac` | compilar, firmar y notarizar Mac (sólo en el runner) |
| `npm run entrega:mac` | armar `Entrega Mac/` con los nombres que ve el comprador |
| `npm run icono:mac` | regenerar `build/icon.icns` y `build/archivo.icns` |

## Importante

- **Después de tocar el código, siempre `npm run contenido:cifrar`.** El build de
  Mac compila con lo que está cifrado: si no se vuelve a cifrar, Mac sale con la
  versión vieja.
- **Nunca se commitean los originales** (`main.js`, `preload.js`, `src/`,
  `pruebas/`), ni la clave, ni los `.dmg` o `.exe`. El `.gitignore` los tapa; aun
  así, antes del primer push mirá `git status --short` y `git ls-files`.
- La clave del contenido vive en el Escritorio, en `firma-apple`, fuera del
  proyecto. Si se pierde, no se puede descifrar nada.
- El mínimo es macOS 12 (Monterey).
