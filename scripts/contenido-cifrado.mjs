#!/usr/bin/env node
/**
 * El código del producto, encriptado, para poder compilar en un repositorio PÚBLICO.
 *
 *   node scripts/contenido-cifrado.mjs generar-clave <archivo>   # una sola vez
 *   node scripts/contenido-cifrado.mjs cifrar       # en la máquina de desarrollo
 *   node scripts/contenido-cifrado.mjs descifrar    # en el runner, antes de compilar
 *   node scripts/contenido-cifrado.mjs verificar    # ¿el cifrado está al día?
 *   node scripts/contenido-cifrado.mjs sellar <archivo-o-carpeta> <salida.mfenc>
 *   node scripts/contenido-cifrado.mjs abrir <entrada.mfenc> <carpeta-destino>
 *
 * La clave se toma, en este orden, de:
 *   1. la opción  --clave-archivo <ruta>
 *   2. la variable de entorno BANCADA_CONTENIDO_KEY (así llega desde el secret)
 *   3. el archivo  <Escritorio>/firma-apple/bancada-contenido.key
 *
 * ---------------------------------------------------------------------------
 * Por qué existe
 * ---------------------------------------------------------------------------
 *
 * El build de Mac corre en GitHub Actions, y sólo los repositorios públicos tienen
 * minutos de macOS sin límite. Pero en un repo público queda a la vista todo lo que
 * se sube, y el código de Bancada ES el producto: el motor de despiece, el plano de
 * corte, los presupuestos. Subirlo en claro sería regalar el programa. Y peor: en un
 * repo público cualquiera puede bajar los artefactos de una corrida, o sea el .dmg
 * terminado.
 *
 * Así que dos cosas viajan encriptadas:
 *
 *  · EL CÓDIGO (main.js, preload.js, src/ y las pruebas unitarias): en el repo sólo
 *    está `contenido-cifrado/app.mfenc`; los originales están en el .gitignore. El
 *    workflow lo descifra antes de compilar.
 *  · LOS ARTEFACTOS (los .dmg y la carpeta de entrega): el workflow los sella antes
 *    de subirlos, y se abren en la máquina de desarrollo con la misma clave.
 *
 * La clave NO está en el repo: vive en el Escritorio, en `firma-apple`, y en el
 * secret BANCADA_CONTENIDO_KEY. Un fork no recibe los secrets, así que no puede
 * descifrar nada.
 *
 * AES-256-GCM: además de ocultar, detecta cualquier alteración. Un archivo tocado o
 * una clave equivocada no descifra "algo raro": falla.
 *
 * NUNCA se imprime la clave ni nada derivado de ella.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PAQUETE = join(ROOT, 'contenido-cifrado', 'app.mfenc')
const CLAVE_LOCAL = join(homedir(), 'Desktop', 'firma-apple', 'bancada-contenido.key')
const MARCA = Buffer.from('BCENC1')
const MARCA_PAQUETE = Buffer.from('BCPKG1')

/**
 * Lo que viaja cifrado. Cada entrada es un archivo o una carpeta (relativa a la
 * raíz del proyecto, con `/`). Si se agrega algo con código del producto, va acá Y
 * en el .gitignore.
 *
 * De `pruebas/` entran sólo las pruebas unitarias (*.test.mjs): son las que corre
 * `npm test` en el runner. Importan reglas de negocio del producto, así que en claro
 * serían tan públicas como el código. Los arneses e2e y las capturas se quedan en la
 * máquina de desarrollo.
 */
const ENTRADAS = ['main.js', 'preload.js', 'src']
const PRUEBAS_DIR = 'pruebas'
const esPrueba = (nombre) => nombre.endsWith('.test.mjs')

/* -------------------------------- clave --------------------------------- */

/** Opciones --clave-archivo y --forzar, sacadas de los argumentos. */
function opciones(argv) {
  const posicionales = []
  const o = { claveArchivo: null, forzar: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--clave-archivo') o.claveArchivo = argv[++i]
    else if (argv[i] === '--forzar') o.forzar = true
    else posicionales.push(argv[i])
  }
  return { ...o, posicionales }
}

let claveArchivoOpcion = null

function clave() {
  let texto = ''
  let origen = ''
  if (claveArchivoOpcion) {
    if (!existsSync(claveArchivoOpcion)) throw new Error(`No existe el archivo de clave indicado: ${claveArchivoOpcion}`)
    texto = readFileSync(claveArchivoOpcion, 'utf8')
    origen = '--clave-archivo'
  } else if (process.env.BANCADA_CONTENIDO_KEY) {
    texto = process.env.BANCADA_CONTENIDO_KEY
    origen = 'BANCADA_CONTENIDO_KEY'
  } else if (existsSync(CLAVE_LOCAL)) {
    texto = readFileSync(CLAVE_LOCAL, 'utf8')
    origen = CLAVE_LOCAL
  }
  const k = Buffer.from(texto.trim(), 'base64')
  if (k.length !== 32) {
    throw new Error(
      'No hay clave de contenido válida (tienen que ser 32 bytes en base64). En el runner es el secret ' +
        'BANCADA_CONTENIDO_KEY; en la máquina de desarrollo, la opción --clave-archivo o el archivo ' +
        `${CLAVE_LOCAL}.` +
        (origen ? ` Se intentó con: ${origen}.` : '')
    )
  }
  return k
}

/* ------------------------------- cifrado -------------------------------- */

export function cifrar(buffer, k) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', k, iv)
  const cuerpo = Buffer.concat([c.update(buffer), c.final()])
  return Buffer.concat([MARCA, iv, c.getAuthTag(), cuerpo])
}

export function descifrar(buffer, k) {
  if (buffer.length < MARCA.length + 28 || !buffer.subarray(0, MARCA.length).equals(MARCA)) {
    throw new Error('No es un archivo cifrado por este script.')
  }
  const iv = buffer.subarray(MARCA.length, MARCA.length + 12)
  const tag = buffer.subarray(MARCA.length + 12, MARCA.length + 28)
  const d = createDecipheriv('aes-256-gcm', k, iv)
  d.setAuthTag(tag)
  try {
    return Buffer.concat([d.update(buffer.subarray(MARCA.length + 28)), d.final()])
  } catch {
    throw new Error('No se pudo descifrar: la clave no es la correcta o el archivo fue alterado.')
  }
}

const sha = (b) => createHash('sha256').update(b).digest('hex')

/* ---------------------- el paquete (varios archivos) ---------------------- */

/** Todos los archivos de una carpeta, recursivo, rutas relativas con `/` y ordenadas. */
function archivosDe(rel) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return []
  if (statSync(abs).isFile()) return [rel]
  const salida = []
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const hijo = `${rel}/${e.name}`
    if (e.isDirectory()) salida.push(...archivosDe(hijo))
    else if (e.isFile()) salida.push(hijo)
  }
  return salida
}

/** Los archivos en claro que corresponden al paquete, ordenados (el orden hace
 *  que dos empaquetados del mismo contenido den bytes idénticos). */
function listarOriginales() {
  const lista = []
  for (const e of ENTRADAS) lista.push(...archivosDe(e))
  const dirPruebas = join(ROOT, PRUEBAS_DIR)
  if (existsSync(dirPruebas)) {
    for (const f of readdirSync(dirPruebas, { withFileTypes: true })) {
      if (f.isFile() && esPrueba(f.name)) lista.push(`${PRUEBAS_DIR}/${f.name}`)
    }
  }
  return [...new Set(lista)].sort()
}

/** Formato: MARCA_PAQUETE, u32 cantidad, y por archivo: u16 largo de ruta, ruta
 *  (utf8), u32 tamaño, datos. Sin tar a propósito: es idéntico en cualquier
 *  sistema y no depende de qué tar haya instalado. */
function empaquetar(rutas) {
  const partes = [MARCA_PAQUETE]
  const n = Buffer.alloc(4)
  n.writeUInt32BE(rutas.length)
  partes.push(n)
  for (const rel of rutas) {
    const datos = readFileSync(join(ROOT, rel))
    const ruta = Buffer.from(rel, 'utf8')
    const cab = Buffer.alloc(2)
    cab.writeUInt16BE(ruta.length)
    const tam = Buffer.alloc(4)
    tam.writeUInt32BE(datos.length)
    partes.push(cab, ruta, tam, datos)
  }
  return Buffer.concat(partes)
}

/** @returns {Map<string, Buffer>} ruta relativa → contenido */
function desempaquetar(buf) {
  if (buf.length < MARCA_PAQUETE.length + 4 || !buf.subarray(0, MARCA_PAQUETE.length).equals(MARCA_PAQUETE)) {
    throw new Error('El paquete descifrado no tiene el formato esperado.')
  }
  let o = MARCA_PAQUETE.length
  const n = buf.readUInt32BE(o)
  o += 4
  const mapa = new Map()
  for (let i = 0; i < n; i++) {
    const largo = buf.readUInt16BE(o)
    o += 2
    const ruta = buf.toString('utf8', o, o + largo)
    o += largo
    const tam = buf.readUInt32BE(o)
    o += 4
    // Defensa contra rutas que se escapen de la raíz: el paquete es autenticado,
    // pero un descifrado nunca debería poder escribir fuera del proyecto.
    if (isAbsolute(ruta) || ruta.split('/').includes('..') || ruta.includes('\\')) {
      throw new Error(`El paquete trae una ruta no permitida: ${ruta}`)
    }
    mapa.set(ruta, buf.subarray(o, o + tam))
    o += tam
  }
  return mapa
}

function leerPaquete(k) {
  if (!existsSync(PAQUETE)) throw new Error('Falta contenido-cifrado/app.mfenc.')
  return desempaquetar(descifrar(readFileSync(PAQUETE), k))
}

/* ------------------------------- comandos -------------------------------- */

function cmdGenerarClave(archivo) {
  if (!archivo) throw new Error('Uso: generar-clave <archivo>')
  const destino = resolve(archivo)
  if (existsSync(destino)) throw new Error(`Ya existe ${destino}: no se pisa. Una clave perdida no se puede recuperar.`)
  mkdirSync(dirname(destino), { recursive: true })
  writeFileSync(destino, randomBytes(32).toString('base64'), { flag: 'wx' })
  console.log(`✓ clave nueva guardada en ${destino} (el contenido no se muestra)`)
}

function cmdCifrar() {
  const k = clave()
  const rutas = listarOriginales()
  if (!rutas.includes('main.js') || !rutas.includes('preload.js') || !rutas.some((r) => r.startsWith('src/'))) {
    throw new Error('Faltan main.js, preload.js o src/: no hay nada coherente que cifrar.')
  }
  const plano = empaquetar(rutas)
  mkdirSync(dirname(PAQUETE), { recursive: true })
  // Si el cifrado vigente ya corresponde a este contenido, no se reescribe: cada
  // cifrado lleva un IV nuevo y ensuciaría el historial con un cambio que no es.
  if (existsSync(PAQUETE)) {
    try {
      if (descifrar(readFileSync(PAQUETE), k).equals(plano)) {
        console.log(`= contenido-cifrado/app.mfenc (sin cambios, ${rutas.length} archivos)`)
        return
      }
    } catch {
      /* se reescribe */
    }
  }
  writeFileSync(PAQUETE, cifrar(plano, k))
  console.log(`✓ ${rutas.length} archivos → contenido-cifrado/app.mfenc (${plano.length} bytes en claro)`)
}

function cmdDescifrar(forzar) {
  const k = clave()
  const mapa = leerPaquete(k)
  // No se descifra encima de trabajo sin cifrar: en la máquina de desarrollo
  // pisaría ediciones recientes con la versión del último cifrado.
  const distintos = []
  for (const [rel, datos] of mapa) {
    const destino = join(ROOT, rel)
    if (existsSync(destino) && !readFileSync(destino).equals(datos)) distintos.push(rel)
  }
  if (distintos.length > 0 && !forzar) {
    throw new Error(
      `Hay ${distintos.length} archivo(s) en claro que difieren de lo cifrado (${distintos.slice(0, 3).join(', ')}` +
        `${distintos.length > 3 ? ', …' : ''}). Si querés pisarlos, repetí con --forzar; si son cambios nuevos, corré "cifrar".`
    )
  }
  for (const [rel, datos] of mapa) {
    const destino = join(ROOT, rel)
    mkdirSync(dirname(destino), { recursive: true })
    writeFileSync(destino, datos)
  }
  console.log(`✓ ${mapa.size} archivos restaurados desde contenido-cifrado/app.mfenc`)
}

/**
 * ¿El cifrado corresponde a los originales de hoy?
 *
 * El build de Mac compila con lo que está CIFRADO en el repo, no con el original.
 * Si alguien corrige algo y no vuelve a cifrar, Windows sale con el cambio y Mac
 * con la versión vieja, sin que nada lo avise. Por eso `build:win` corre esto
 * primero y corta. Compara el hash de cada original contra lo cifrado, en las dos
 * direcciones: archivos distintos, sobrantes y faltantes.
 */
function cmdVerificar() {
  const k = clave()
  const mapa = leerPaquete(k)
  const originales = listarOriginales()
  if (originales.length === 0) throw new Error('No hay archivos originales en esta carpeta: no hay nada que verificar.')
  const problemas = []
  for (const rel of originales) {
    if (!mapa.has(rel)) problemas.push(`${rel} (no está en el cifrado)`)
    else if (sha(readFileSync(join(ROOT, rel))) !== sha(mapa.get(rel))) problemas.push(`${rel} (cambió)`)
  }
  for (const rel of mapa.keys()) {
    if (!originales.includes(rel)) problemas.push(`${rel} (está cifrado pero ya no existe)`)
  }
  if (problemas.length > 0) {
    throw new Error(
      `El cifrado está desactualizado: ${problemas.slice(0, 5).join('; ')}${problemas.length > 5 ? '; …' : ''}. ` +
        'Corré "npm run contenido:cifrar".'
    )
  }
  console.log(`✓ el contenido cifrado está al día con los originales (${originales.length} archivos)`)
}

/*
 * Para los artefactos: empaqueta con tar (está en macOS, Linux y Windows 10+) y
 * cifra el paquete.
 *
 * El tar va por la entrada y la salida estándar, con `cwd`, y NUNCA recibe una
 * ruta: el tar de GNU que trae Git para Windows toma "C:/…" como un servidor
 * remoto ("Cannot connect to C: resolve failed").
 */
const MAX_TAR = 4 * 1024 * 1024 * 1024

function cmdSellar(entrada, salida) {
  if (!entrada || !salida) throw new Error('Uso: sellar <archivo-o-carpeta> <salida.mfenc>')
  const k = clave()
  const abs = resolve(entrada)
  if (!existsSync(abs)) throw new Error(`No existe ${entrada}.`)
  const r = spawnSync('tar', ['-cf', '-', basename(abs)], { cwd: dirname(abs), maxBuffer: MAX_TAR })
  if (r.status !== 0) throw new Error(`tar falló: ${String(r.stderr ?? '').trim()}`)
  mkdirSync(dirname(resolve(salida)), { recursive: true })
  writeFileSync(salida, cifrar(r.stdout, k))
  console.log(`✓ ${entrada} → ${salida} (${(statSync(salida).size / 1048576).toFixed(1)} MB, cifrado)`)
}

function cmdAbrir(entrada, destino) {
  if (!entrada || !destino) throw new Error('Uso: abrir <entrada.mfenc> <carpeta-destino>')
  const plano = descifrar(readFileSync(entrada), clave())
  mkdirSync(destino, { recursive: true })
  const r = spawnSync('tar', ['-xf', '-'], { cwd: destino, input: plano, maxBuffer: MAX_TAR })
  if (r.status !== 0) throw new Error(`tar falló al extraer: ${String(r.stderr ?? '').trim()}`)
  console.log(`✓ ${entrada} → ${destino}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { claveArchivo, forzar, posicionales } = opciones(process.argv.slice(2))
  claveArchivoOpcion = claveArchivo ? resolve(claveArchivo) : null
  const [cmd, a, b] = posicionales
  try {
    if (cmd === 'generar-clave') cmdGenerarClave(a)
    else if (cmd === 'cifrar') cmdCifrar()
    else if (cmd === 'descifrar') cmdDescifrar(forzar)
    else if (cmd === 'verificar') cmdVerificar()
    else if (cmd === 'sellar') cmdSellar(a, b)
    else if (cmd === 'abrir') cmdAbrir(a, b)
    else {
      throw new Error(
        'Comandos: generar-clave <archivo> | cifrar | descifrar [--forzar] | verificar | sellar <entrada> <salida> | abrir <entrada> <destino>  (opción: --clave-archivo <ruta>)'
      )
    }
  } catch (e) {
    console.error(`✗ ${e.message}`)
    process.exit(1)
  }
}
