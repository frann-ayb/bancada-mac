# Cómo firmar y notarizar Bancada para macOS

Sin tener una Mac. Se compila, firma y notariza en un runner de GitHub, igual que
Mediflashy. El certificado de Apple es el mismo: no hay que sacar uno nuevo.

---

## El repositorio es PÚBLICO, y lo que se vende va cifrado

Tiene que ser **público**: sólo los repos públicos tienen minutos de macOS sin
límite. En uno privado se descuentan 10 veces y no alcanzan.

Un repo público tiene dos problemas, y los dos se resuelven con
`scripts/contenido-cifrado.mjs` (AES-256-GCM):

1. **El código ES el producto.** `main.js`, `preload.js` y `src/` (y las pruebas
   unitarias) NO se suben: están en el `.gitignore`. En el repo sólo está su
   versión cifrada, `contenido-cifrado/app.mfenc`. El workflow la descifra antes
   de compilar, y antes verifica que los originales no se hayan colado en el
   repositorio.
2. **Cualquiera puede bajar los artefactos de un repo público.** Un `.dmg` suelto
   sería la app entera, gratis. Por eso el workflow los sube **sellados**
   (`.mfenc`) y se abren en la máquina de desarrollo:
   ```bash
   node scripts/contenido-cifrado.mjs abrir bancada-mac-entrega.mfenc .
   ```
   El destino es la carpeta donde querés que aparezca el resultado, no el nombre
   de la carpeta: el paquete ya trae adentro `Entrega Mac/`, así que con `.`
   queda `Entrega Mac/` al lado de la entrega de Windows. Poner `"Entrega Mac"`
   como destino la dejaría repetida (`Entrega Mac/Entrega Mac/`).

### La clave

Se genera una sola vez, fuera del repo:

```bash
node scripts/contenido-cifrado.mjs generar-clave "%USERPROFILE%\Desktop\firma-apple\bancada-contenido.key"
```

Queda en `firma-apple\bancada-contenido.key` (en el Escritorio) y se carga como
secret `BANCADA_CONTENIDO_KEY`. El script la busca ahí por defecto; también acepta
`--clave-archivo <ruta>` o la variable de entorno `BANCADA_CONTENIDO_KEY`.

**Si se pierde, no se puede descifrar nada**: hay que generar una nueva y volver a
cifrar. Guardá una copia en otro lugar, y no la pegues en ningún chat ni archivo
del proyecto.

### Después de tocar el código, siempre cifrar

```bash
npm run contenido:cifrar
```

El build de Mac compila con lo cifrado: si no se vuelve a cifrar, Mac sale con el
código viejo. `npm run build:win` corre `contenido:verificar` primero y corta si
quedó desactualizado.

Si querés que el workflow `Pruebas en Mac` corra también el recorrido de punta a
punta, sellá la carpeta de pruebas al lado del paquete:

```bash
node scripts/contenido-cifrado.mjs sellar pruebas contenido-cifrado/pruebas.mfenc
```

### Qué NO se sube

Lo cuida el `.gitignore`: `main.js`, `preload.js`, `src/`, `pruebas/`,
instaladores (`*.exe`, `*.dmg`), `dist/`, `Entrega Mac/`, `sellado/`, capturas,
`node_modules/` y cualquier material de firma (`*.p12`, `*.key`, `*.b64`, ...).
Antes del primer push:

```bash
git status --short     # ni main.js, ni src/, ni .exe, ni .dmg, ni claves
git ls-files           # build/, scripts/, .github/, contenido-cifrado/app.mfenc, package*.json
```

**No se commitean los originales.** Un archivo que entra al historial ya no sale.

Lo que SÍ queda a la vista: los scripts, los iconos, la configuración de
empaquetado y los workflows. Nada del código del programa.

---

## Los siete secretos

| Secret | De dónde sale |
|---|---|
| `CSC_LINK` | `developerID.p12.b64` (una sola línea) |
| `CSC_KEY_PASSWORD` | `p12-password.txt` |
| `CSC_NAME` | el Common Name **sin** `Developer ID Application: ` → `NOMBRE (TEAMID)` |
| `APPLE_ID` | el Apple ID del certificado |
| `APPLE_APP_SPECIFIC_PASSWORD` | `apple-app-specific-password.txt`, formato `xxxx-xxxx-xxxx-xxxx` |
| `APPLE_TEAM_ID` | el Team ID, 10 caracteres |
| `BANCADA_CONTENIDO_KEY` | `bancada-contenido.key`: la clave del código y de los artefactos |

Todo vive en la carpeta `firma-apple` del Escritorio, **fuera del repositorio**.
Los secretos de GitHub son por repositorio y de sólo escritura: los de otro repo
(Mediflashy, Convertexto) no pasan a éste.

Para cargarlos sin que se vean en pantalla, con la CLI de GitHub y leyendo el
archivo por entrada estándar:

```bash
gh secret set CSC_LINK < developerID.p12.b64
gh secret set BANCADA_CONTENIDO_KEY < bancada-contenido.key
```

o a mano en `Settings → Secrets and variables → Actions`. Un salto de línea pegado
al final rompe `notarytool` sin decirlo: el workflow verifica el Team ID y el
largo de la clave antes de gastar el build.

**Cuidado con `CSC_NAME`:** si arranca con `Developer ID Application: `,
electron-builder corta. El workflow lo verifica al principio sin imprimirlo. Y la
clave `identity` no tiene que volver a `package.json`: si vuelve, gana sobre el
secret.

---

## Primera corrida: validar la firma

`Actions → Compilar para Mac → Run workflow`, con **`armar_entrega` en `false`**.

Descifra el código, corre las pruebas unitarias en macOS, y firma y notariza de
verdad los dos `.dmg` (Apple Silicon e Intel). Tarda unos 15 a 25 minutos, casi
todo esperando a Apple. El artefacto se llama **`bancada-mac-prueba`** y viene
sellado.

### Qué mirar en el log

El paso **"Qué firma quedó, en las dos arquitecturas"**, para cada `.app`:

```
CodeDirectory ... flags=0x10000(runtime)          ← hardened runtime
Authority=Developer ID Application: ***           ← el nombre se oculta a propósito
Authority=Developer ID Certification Authority
Authority=Apple Root CA                           ← tres autoridades
Timestamp=...                                     ← sello de tiempo
The validate action worked!                       ← ticket pegado
accepted / source=Notarized Developer ID          ← Gatekeeper
```

El log es público, así que el nombre del titular del certificado y el Team ID
salen como `***`: lo que se mira es que la línea exista. Las pruebas unitarias
muestran un renglón por prueba (el detalle va en el artefacto sellado).

`rejected` con `source=Unnotarized Developer ID` = firmada pero **sin notarizar**:
faltó un secret (buscar `skipped macOS notarization`).

Antes de eso, `verify-firma-mac` ya revisó, y cortó si algo estaba mal: la firma
de la app y de sus cuatro Helpers, el `Info.plist` (identificador, macOS 12 como
mínimo, la extensión `.bancada`), que estén los dos iconos, que el código viaje en
el `app.asar` sin pruebas ni trabajos de ejemplo, y los nombres de los dos `.dmg`.

---

## Segunda corrida: la entrega

Con **`armar_entrega` en `true`**. Arma la carpeta `Entrega Mac` con los dos
instaladores con los nombres que ve el comprador:

- `Bancada - Mac con chip Apple (M1, M2, M3, M4).dmg`
- `Bancada - Mac con Intel.dmg`

El artefacto se llama **`bancada-mac-entrega`**, viene sellado y al abrirlo trae
la carpeta `Entrega Mac`: va al lado de la entrega de Windows.

El artefacto trae **sólo los dos `.dmg`**. La guía del comprador (el PDF
`Como instalar Bancada en Mac.pdf`) no viaja en el repositorio, porque la carpeta
`.guia-mac/` y `Entrega Mac/` están en `.gitignore`: se queda en tu máquina y al
abrir el artefacto con `.` queda al lado de los instaladores (el archivo de
sellado no borra lo que ya está en la carpeta). Si la copiás a mano, ponela
adentro de `Entrega Mac/` antes de subir la entrega a la tienda.

---

## Cómo abrir un artefacto sellado

1. Bajá el `.zip` del artefacto desde la pestaña Actions (o con
   `gh run download <id> -n bancada-mac-entrega`).
2. Descomprimilo: adentro hay un único `.mfenc`.
3. Abrilo con la clave, desde la carpeta donde querés que quede:
   ```bash
   node scripts/contenido-cifrado.mjs abrir bancada-mac-entrega.mfenc .
   ```
   Queda la carpeta `Entrega Mac/` con los dos `.dmg`. El artefacto de la
   primera corrida (`bancada-mac-prueba.mfenc`) se abre igual y deja la carpeta
   `bancada-mac-prueba/`, con los `.dmg` y, en `logs-unitarios/`, el detalle de
   las pruebas unitarias.

Si dice `No se pudo descifrar: la clave no es la correcta`, el secret del
repositorio no es el del archivo local.

---

## Probar en Mac sin tener una

El workflow `Probar en Mac` baja el artefacto sellado, monta el `.dmg`, lo copia
a `/Applications` con la cuarentena real de Safari, le exige a Gatekeeper que lo
acepte y arranca la app para ver que cargue la interfaz y escriba en
`~/Library/Application Support/Bancada`.

**Tampoco prueba el uso real**: cómo se ve la barra de título con los semáforos,
el menú, el doble clic en un `.bancada` desde Finder. Eso necesita una Mac de
verdad: conviene que alguien con una la abra antes de vender.

---

## Si algo falla

| Síntoma | Causa |
|---|---|
| `MAC verification failed during PKCS12 import` | `.p12` con los defaults de OpenSSL 3 |
| build en verde, `.dmg` sin notarizar | falta un secret: buscar `skipped macOS notarization` |
| `unable to build chain to self-signed root` | al `.p12` le falta el intermedio |
| `Please remove prefix "Developer ID Application:"` | `CSC_NAME` tiene el prefijo |
| `does not have the hardened runtime enabled` | un binario que no tomó el hardened runtime |
| la app abre **en blanco** | falta `allow-jit` en `entitlements.mac.inherit.plist` |
| `library load disallowed` en la consola | ya está `disable-library-validation` en los DOS plist; si aparece igual, hay un binario firmado con otro Team ID: mirar la salida de `verify-firma-mac` |
| `a sealed resource is missing or invalid` | algo modificó el bundle después de firmar |
| notarytool devuelve 403 y habla de contratos | falta aceptar un acuerdo del Developer Program |
| `No se pudo descifrar: la clave no es la correcta` | `BANCADA_CONTENIDO_KEY` no es la del archivo local |
| `está en el repositorio SIN cifrar` | se commiteó `main.js` o `preload.js`: hay que sacarlo del historial |
| `El cifrado está desactualizado` | se tocó el código y no se corrió `npm run contenido:cifrar` |
| `504` bajando Electron o la herramienta del `.dmg` | el paso `precalentar` reintenta; si persiste, relanzar el workflow |

Si Apple rechaza el envío, el paso `if: failure()` le pide a `notarytool` el log
de **ese** envío (el más reciente cuyo archivo se llama Bancada): es el único
lugar donde figura el archivo culpable. El historial completo de la cuenta no se
imprime, porque es el de todos los productos y el log es público.

---

## Antes del primer commit: el correo de git

Cada commit lleva el nombre y el correo configurados en git, y en un repo público
quedan a la vista para siempre. La configuración global de esta máquina tiene el
correo real, así que en este repositorio, **antes del primer commit**:

```bash
git config user.name  "Bancada"
git config user.email "<id>+<usuario>@users.noreply.github.com"
```

(el correo `noreply` figura en GitHub, en `Settings → Emails`), y ahí mismo se
activan `Keep my email address private` y `Block command line pushes that expose
my email`. Conviene también que el usuario o la organización de GitHub y el
nombre del repositorio no sean el nombre real. Un commit con el correo ya subido
no se puede limpiar sin reescribir la historia.
