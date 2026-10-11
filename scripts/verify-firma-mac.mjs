#!/usr/bin/env node
/**
 * Portero de la firma y la notarización. Se corre DESPUÉS de electron-builder y
 * corta el build si los .app que acaba de generar no están firmados con Developer
 * ID y notarizados como corresponde.
 *
 * POR QUÉ EXISTE, y por qué no alcanza con `notarize: true`
 * --------------------------------------------------------
 * app-builder-lib NO corta si faltan las variables de entorno de notarización:
 * imprime "skipped macOS notarization" y sigue. O sea que un secret mal cargado
 * produce dos .dmg SIN NOTARIZAR, un build en verde, y un aviso perdido entre
 * miles de líneas de log. El comprador ve el cartel de Gatekeeper y nos enteramos
 * por un reclamo. Este script es el corte que electron-builder no hace.
 *
 * Además de la firma, mira lo que se puede romper sin que nadie se entere:
 *   · el Info.plist (identificador, macOS mínimo, la asociación de .bancada)
 *   · que los iconos estén (sin ellos electron-builder usa el de Electron, en verde)
 *   · que el código viaje en el app.asar y que NO viajen pruebas ni trabajos
 *   · los entitlements efectivos (si falta allow-jit la app abre en blanco)
 *
 * Uso:
 *   node scripts/verify-firma-mac.mjs      # o `npm run verify:firma-mac`
 *
 * Lee APPLE_TEAM_ID del entorno. Si está, exige que la firma declare ESE Team ID
 * y agrega el requisito compuesto de codesign; si no está, se conforma con que
 * haya alguno (así el script sirve para mirar un build ajeno).
 *
 * Sale 0 si está todo; 1 con la lista de problemas y qué mirar; 2 si se lo corre
 * fuera de macOS (usa codesign, spctl y xcrun stapler, que sólo existen ahí).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SALIDA = join(ROOT, 'dist')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const TEAM_ID = (process.env.APPLE_TEAM_ID ?? '').trim()

const log = (msg) => console.log(`[firma] ${msg}`)
/** Rutas relativas al proyecto y con `/`: se leen igual en cualquier log. */
const corta = (p) => relative(ROOT, p).split(sep).join('/')

/* ------------------------------- problemas ------------------------------- */

/**
 * No se corta en el primer problema: se juntan todos. "No está firmado" y "está
 * firmado pero sin sello de tiempo" se arreglan distinto, y enterarse de a uno
 * cuesta 40 minutos de build por vez.
 */
const problemas = []
const problema = (que, detalle) => problemas.push({ que, detalle: oculta(detalle) })

/**
 * El log de GitHub Actions de un repo público lo lee cualquiera. El enmascarado
 * de secrets sólo tapa coincidencias exactas del valor, y el nombre del titular
 * del certificado o el Team ID pueden salir con otra forma (parcial, otra
 * capitalización). Por eso nada de esto los imprime: queda "***".
 */
function oculta(texto) {
  let s = String(texto ?? '')
  s = s.replace(/(Developer ID Application: ).*/g, '$1***')
  s = s.replace(/(TeamIdentifier=).*/g, '$1***')
  if (TEAM_ID) s = s.split(TEAM_ID).join('***')
  return s
}

/** Afirma una cosa concreta. `detalle` es lo que se imprime si falla. */
function check(condicion, que, detalle) {
  if (condicion) {
    console.log(`  OK    ${que}`)
    return true
  }
  console.log(`  FALLA ${que}`)
  problema(que, detalle)
  return false
}

/** Lo que no se pudo comprobar: se anota, no corta. */
const aviso = (que) => console.log(`  AVISO ${que}`)

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  // codesign y spctl escriben en stderr incluso cuando salen bien: se junta todo.
  return { status: r.status, stdout: r.stdout ?? '', salida: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/* ------------------------------ plataforma ------------------------------- */

if (process.platform !== 'darwin') {
  console.error('[firma] Sólo corre en macOS: usa codesign, spctl y xcrun stapler.')
  process.exit(2)
}

/* ------------------------- qué .app hay que mirar ------------------------ */

/**
 * Las carpetas que deja electron-builder, una por arquitectura. Se DESCUBREN en
 * vez de escribirse a mano porque el sufijo lo decide builder-util y no es obvio:
 * `mac-arm64` para Apple Silicon y `mac` a secas para x64, que es la arquitectura
 * por defecto.
 */
const bundles = existsSync(SALIDA)
  ? readdirSync(SALIDA)
      .filter((d) => d === 'mac' || d.startsWith('mac-'))
      .map((d) => join(SALIDA, d, `${PKG.productName}.app`))
      .filter(existsSync)
  : []

if (bundles.length === 0) {
  console.error(`[firma] No encontré ningún "${PKG.productName}.app" en dist/.`)
  console.error('[firma] ¿Corrió electron-builder? Este script va DESPUÉS del empaquetado.')
  process.exit(2)
}

/* ------------------------------ la firma -------------------------------- */

/**
 * Lo que TIENE que cumplir cualquier Mach-O del bundle. Se afirma cada cosa por
 * separado a propósito: un booleano único no distingue entre "no está firmado" y
 * "está firmado pero le falta el hardened runtime", y el arreglo es distinto.
 *
 * @param {string} etiqueta  cómo se llama esto en el mensaje
 * @param {string} path      el .app o el binario
 */
function verificarFirma(etiqueta, path) {
  const { salida } = sh('codesign', ['-dv', '--verbose=4', path])
  const linea = (re) => (salida.match(re) ?? [])[0] ?? '(ausente)'
  const autoridades = salida.match(/^Authority=.*$/gm) ?? []

  // Con Developer ID, codesign NO imprime ninguna línea `Signature=`: imprime
  // `Signature size=NNNN`. Que apareciera "adhoc" significa que electron-builder
  // no encontró el certificado y firmó por las suyas: ese .dmg no se puede entregar.
  check(
    !/Signature=adhoc/.test(salida),
    `${etiqueta}: no quedó con la firma ad-hoc`,
    `${linea(/^Signature.*$/m)} — electron-builder no encontró el certificado. Revisá CSC_LINK, CSC_KEY_PASSWORD y CSC_NAME.`
  )

  check(
    /^Authority=Developer ID Application: /m.test(salida),
    `${etiqueta}: firmado con un Developer ID Application`,
    autoridades[0] ?? '(sin ninguna línea Authority)'
  )

  // Tienen que salir TRES líneas Authority: hoja, intermedio y raíz. Si sale una
  // sola, al .p12 le falta el certificado intermedio de Apple.
  check(
    /Apple Root CA/.test(salida),
    `${etiqueta}: la cadena de certificados llega hasta Apple Root CA`,
    `${autoridades.length} autoridad(es): ${autoridades.join(' | ') || '(ninguna)'} — si es una sola, rehacé el .p12 con -certfile (los intermedios de apple.com/certificateauthority).`
  )

  check(
    /^Timestamp=/m.test(salida),
    `${etiqueta}: tiene sello de tiempo seguro`,
    'sin la línea Timestamp= notarytool rechaza el envío con "The signature does not include a secure timestamp"'
  )

  check(
    /flags=\S*runtime/.test(salida),
    `${etiqueta}: hardened runtime activado`,
    `${linea(/^CodeDirectory.*$/m)} — sin el flag runtime, Apple rechaza con "The executable does not have the hardened runtime enabled"`
  )

  if (TEAM_ID) {
    check(
      salida.includes(`TeamIdentifier=${TEAM_ID}`),
      `${etiqueta}: el Team ID es ${TEAM_ID}`,
      `${linea(/^TeamIdentifier=.*$/m)} — no coincide con APPLE_TEAM_ID`
    )

    // La afirmación más fuerte, en un solo comando: que la cadena ancle en Apple Y
    // que la hoja sea nuestro Team ID.
    const req = sh('codesign', [
      '--verify',
      '--strict',
      '-R',
      `=anchor apple generic and certificate leaf[subject.OU] = "${TEAM_ID}"`,
      path
    ])
    check(req.status === 0, `${etiqueta}: cumple "anchor apple generic + OU=${TEAM_ID}"`, req.salida.trim().slice(-300))
  } else {
    check(
      /^TeamIdentifier=(?!not set)/m.test(salida),
      `${etiqueta}: declara algún Team ID`,
      `${linea(/^TeamIdentifier=.*$/m)} — poné APPLE_TEAM_ID en el entorno para exigir el valor exacto`
    )
  }
}

/** Los entitlements que quedaron firmados en `path`, como texto XML (o '' si no se pudo leer). */
function entitlementsDe(path) {
  const r = sh('codesign', ['-d', '--entitlements', ':-', path])
  return r.stdout.includes('<plist') ? r.stdout : ''
}

/* ------------------------------ Info.plist ------------------------------- */

/** Info.plist del .app como objeto (plutil lo convierte a JSON). */
function leerInfoPlist(app) {
  const r = sh('plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')])
  try {
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

/** Lista de archivos de un app.asar, con `/` y sin la barra inicial; o null si no se pudo leer. */
function listarAsar(archivo) {
  try {
    const asar = createRequire(join(ROOT, 'package.json'))('@electron/asar')
    return asar.listPackage(archivo, { isPack: false }).map((p) => p.split(sep).join('/').replace(/^\/+/, ''))
  } catch {
    return null
  }
}

/* ------------------------------- recorrida ------------------------------- */

for (const app of bundles) {
  console.log('')
  log(corta(app))

  verificarFirma('la app', app)

  // El sello del .app incluye el hash de TODO lo que hay en Contents/. Si algo se
  // modificó después de firmar, acá aparece como "a sealed resource is missing".
  const deep = sh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  check(deep.status === 0, 'la app: la firma verifica en todo el bundle (--deep --strict)', deep.salida.trim().slice(-300))

  // Los Helpers son los procesos que corren V8: se firman con el .inherit y
  // también tienen que pasar los chequeos.
  const frameworks = join(app, 'Contents', 'Frameworks')
  const helpers = existsSync(frameworks) ? readdirSync(frameworks).filter((f) => /^.+ Helper.*\.app$/.test(f)) : []
  check(helpers.length >= 4, 'la app: están los cuatro Helpers de Electron', `encontré ${helpers.length}: ${helpers.join(', ') || 'ninguno'}`)
  for (const h of helpers) verificarFirma(h.replace(/\.app$/, ''), join(frameworks, h))

  // Entitlements efectivos. La sintaxis de codesign para volcarlos no es algo que
  // se pueda dar por segura: si no devuelve un plist, es aviso y no falla.
  const ejecutable = join(app, 'Contents', 'MacOS', PKG.productName)
  const rendererHelper = helpers.find((h) => /\(Renderer\)/.test(h))
  for (const [etiqueta, ruta] of [
    ['la app', ejecutable],
    ['el Helper (Renderer)', rendererHelper ? join(frameworks, rendererHelper) : null]
  ]) {
    if (!ruta || !existsSync(ruta)) continue
    const ent = entitlementsDe(ruta)
    if (!ent) aviso(`${etiqueta}: no pude leer los entitlements firmados (codesign -d --entitlements :-)`)
    else {
      check(
        /com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/.test(ent),
        `${etiqueta}: lleva el entitlement allow-jit`,
        'sin allow-jit el renderer (V8) muere al arrancar y la app abre en blanco; revisá build/entitlements.mac*.plist'
      )
    }
  }

  // Info.plist
  const info = leerInfoPlist(app)
  if (!info) {
    check(false, 'la app: se puede leer el Info.plist', 'plutil no devolvió JSON')
  } else {
    check(
      info.CFBundleIdentifier === PKG.build.appId,
      `la app: CFBundleIdentifier es ${PKG.build.appId}`,
      `vale ${info.CFBundleIdentifier}`
    )
    check(
      info.LSMinimumSystemVersion === PKG.build.mac.minimumSystemVersion,
      `la app: macOS mínimo ${PKG.build.mac.minimumSystemVersion}`,
      `LSMinimumSystemVersion vale ${info.LSMinimumSystemVersion}`
    )
    check(
      info.LSApplicationCategoryType === PKG.build.mac.category,
      'la app: categoría de la App Store declarada',
      `LSApplicationCategoryType vale ${info.LSApplicationCategoryType}`
    )
    const tiposDoc = Array.isArray(info.CFBundleDocumentTypes) ? info.CFBundleDocumentTypes : []
    check(
      tiposDoc.some((t) => (t.CFBundleTypeExtensions ?? []).includes('bancada')),
      'la app: declara la extensión .bancada (doble clic en Finder)',
      `CFBundleDocumentTypes: ${JSON.stringify(tiposDoc).slice(0, 200)}`
    )
    const uti = Array.isArray(info.UTExportedTypeDeclarations) ? info.UTExportedTypeDeclarations : []
    check(
      uti.some((u) => JSON.stringify(u).includes('bancada')),
      'la app: exporta el tipo de documento de Bancada (UTExportedTypeDeclarations)',
      `UTExportedTypeDeclarations: ${JSON.stringify(uti).slice(0, 200)}`
    )
  }

  // Iconos: si falta uno, electron-builder usa el de Electron y el build sale en verde.
  const recursos = join(app, 'Contents', 'Resources')
  for (const f of ['icon.icns', 'archivo.icns']) {
    check(existsSync(join(recursos, f)), `la app: trae ${f}`, `no está en ${corta(recursos)}`)
  }

  // Qué viajó en el app.asar: el código sí; pruebas y trabajos de ejemplo, no.
  const asarPath = join(recursos, 'app.asar')
  if (!existsSync(asarPath)) {
    check(false, 'la app: trae app.asar', `no está en ${corta(recursos)}`)
  } else {
    const lista = listarAsar(asarPath)
    if (!lista) aviso('no pude abrir el app.asar con @electron/asar')
    else {
      for (const f of ['main.js', 'preload.js', 'src/index.html', 'package.json']) {
        check(lista.includes(f), `app.asar: trae ${f}`, 'el código del producto no llegó al paquete: ¿corrió "descifrar" antes del build?')
      }
      const sobrantes = lista.filter(
        (p) => /\.test\.mjs$/.test(p) || /\.bancada$/.test(p) || p.startsWith('pruebas/') || p.startsWith('contenido-cifrado/')
      )
      check(sobrantes.length === 0, 'app.asar: no trae pruebas ni trabajos de ejemplo', sobrantes.slice(0, 5).join(', '))
    }
  }

  // LA notarización. `stapler validate` es lo único que prueba que el ticket está
  // PEGADO al bundle, que es lo que hace que la Mac del comprador la acepte
  // incluso sin internet.
  const stapler = sh('xcrun', ['stapler', 'validate', app])
  check(
    stapler.status === 0,
    'la app: tiene el ticket de notarización pegado',
    `${stapler.salida.trim().slice(-300)} — "Error 65" significa que no hay ticket: la notarización no corrió (buscá "skipped macOS notarization" más arriba en el log) o no llegó a pegarlo.`
  )

  // Y esto es, literalmente, lo que va a decidir si el comprador puede abrirla.
  const spctl = sh('spctl', ['-a', '-t', 'exec', '-vvv', app])
  log(`  spctl: ${oculta(spctl.salida.trim()).replace(/\n/g, ' | ')}`)
  check(spctl.status === 0, 'la app: Gatekeeper la ACEPTA', spctl.salida.trim().slice(-300))
  check(
    /source=Notarized Developer ID/.test(spctl.salida),
    'la app: Gatekeeper la reconoce como NOTARIZADA',
    `${spctl.salida.trim().slice(-300)} — "source=Unnotarized Developer ID" quiere decir bien firmada pero SIN notarizar.`
  )
}

/* --------------------------- los .dmg de salida -------------------------- */

console.log('')
const dmgs = existsSync(SALIDA) ? readdirSync(SALIDA).filter((f) => f.endsWith('.dmg')) : []
check(dmgs.length === 2, 'se generaron los dos .dmg (arm64 e Intel)', `encontré ${dmgs.length}: ${dmgs.join(', ') || 'ninguno'}`)
check(
  dmgs.some((f) => /macOS-arm64\.dmg$/.test(f)) && dmgs.some((f) => /macOS-x64\.dmg$/.test(f)),
  'los .dmg se llaman ...-macOS-arm64.dmg y ...-macOS-x64.dmg',
  dmgs.join(', ') || 'ninguno'
)

/* -------------------------------- final --------------------------------- */

console.log('')
if (problemas.length > 0) {
  log(`${problemas.length} verificación(es) fallaron. Los .dmg NO se pueden entregar.`)
  console.log('')
  for (const { que, detalle } of problemas) {
    console.log(`  · ${que}`)
    if (detalle) console.log(`      ${String(detalle).split('\n').slice(0, 4).join('\n      ')}`)
  }
  console.log('')
  log('Si más arriba en el log dice "skipped macOS notarization", falta algún secret:')
  log('  APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.')
  log('Si Apple rechazó el envío, el paso siguiente del workflow pide el motivo exacto')
  log('(nombra el archivo culpable). A mano, con el id del envío de esta corrida:')
  log('  xcrun notarytool log <submission-id> --apple-id "$APPLE_ID" \\')
  log('    --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID"')
  process.exit(1)
}

log('Firma y notarización verificadas: los .dmg se pueden entregar.')
