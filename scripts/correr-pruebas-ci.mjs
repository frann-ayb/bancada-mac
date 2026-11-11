#!/usr/bin/env node
/**
 * Corre las pruebas unitarias del runner de Mac, una por una, y deja un renglón por
 * prueba.
 *
 *   node scripts/correr-pruebas-ci.mjs              # todas las de pruebas/ci-lista.json
 *   node scripts/correr-pruebas-ci.mjs empaquetado  # sólo las que empiezan con ese texto
 *
 * Por qué existe en vez de un `for` en el workflow:
 *
 *  · La lista de pruebas vive en pruebas/ci-lista.json, que viaja CIFRADA. El
 *    repositorio es público: el script no la nombra y el log de la corrida tampoco
 *    (en GitHub Actions cada prueba sale con su número, no con su nombre).
 *  · La salida completa de cada prueba repite reglas de negocio (aprovechamientos,
 *    tablas de presupuesto, rutas del código), así que va a un archivo y a la
 *    consola sólo va el conteo que la prueba imprime al final. Los archivos quedan
 *    en la carpeta de registros para sellarlos y subirlos como artefacto:
 *      BANCADA_LOGS_PRUEBAS, o $RUNNER_TEMP/logs-unitarios, o <temporal>/logs-unitarios
 *  · Si una prueba se cae, en el log sólo sale el tipo de error, nunca el mensaje ni
 *    una línea del código.
 *
 * En la máquina de desarrollo (sin GITHUB_ACTIONS) se muestran los nombres, para
 * poder trabajar. Con --sin-nombres se ocultan igual.
 *
 * Sale 0 si pasaron todas; 1 si alguna falló; 2 si la lista no está o no se puede leer.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LISTA = join(ROOT, 'pruebas', 'ci-lista.json')
/** Tope por prueba: la más lenta tarda alrededor de un minuto; esto corta una colgada. */
const TOPE_MS = 10 * 60 * 1000

const argumentos = process.argv.slice(2)
const ocultarNombres = process.env.GITHUB_ACTIONS === 'true' || argumentos.includes('--sin-nombres')
const filtro = argumentos.find((a) => !a.startsWith('--')) ?? ''

if (!existsSync(LISTA)) {
  console.error('No encuentro pruebas/ci-lista.json: ¿se descifró el paquete de pruebas? (node scripts/contenido-cifrado.mjs descifrar)')
  process.exit(2)
}

let pruebas
try {
  pruebas = JSON.parse(readFileSync(LISTA, 'utf8')).pruebas
  if (!Array.isArray(pruebas) || pruebas.length === 0) throw new Error('lista vacía')
} catch (e) {
  console.error(`pruebas/ci-lista.json no se pudo leer: ${e.message}`)
  process.exit(2)
}
if (filtro) pruebas = pruebas.filter((p) => p.startsWith(filtro))
if (pruebas.length === 0) {
  console.error(`Ninguna prueba de la lista empieza con "${filtro}".`)
  process.exit(2)
}

const carpetaLogs = process.env.BANCADA_LOGS_PRUEBAS || join(process.env.RUNNER_TEMP || tmpdir(), 'logs-unitarios')
mkdirSync(carpetaLogs, { recursive: true })

// Las pruebas no necesitan Electron; si la variable viene puesta (en esta PC viene en 1)
// se quita, no se vacía.
const entorno = { ...process.env }
delete entorno.ELECTRON_RUN_AS_NODE

/**
 * Sólo la cantidad que la prueba cuenta al final (por ejemplo «47 pruebas» de «47 pruebas, todas
 * bien · 0.2 s»). El resto de esa línea puede traer datos del producto («339 ambientes armados»):
 * no sale.
 */
function resumenDe(texto) {
  const lineas = texto.split(/\r?\n/).map((l) => l.replace(/[═─=━]+/g, '').trim()).filter(Boolean)
  const conteo = /(\d+)\s*(?:de\s*(\d+)\s*)?(pruebas?|comprobaciones?|casos?)/i
  for (let i = lineas.length - 1; i >= 0; i--) {
    const m = lineas[i].match(conteo)
    if (m) return m[2] ? `${m[1]} de ${m[2]} ${m[3].toLowerCase()}` : `${m[1]} ${m[3].toLowerCase()}`
  }
  return '(sin conteo)'
}

/** Sólo el tipo del error, por ejemplo «AssertionError»; nunca el mensaje. */
function tipoDeErrorDe(texto) {
  const m = texto.match(/^\s*(?:Uncaught\s+)?([A-Za-z]*Error)\b/m)
  return m ? m[1] : null
}

let fallaron = 0
const ancho = String(pruebas.length).length
pruebas.forEach((nombre, i) => {
  const n = `${String(i + 1).padStart(ancho, '0')}/${pruebas.length}`
  const etiqueta = ocultarNombres ? `prueba ${n}` : `${n} ${nombre.replace(/\.test\.mjs$/, '')}`
  const t0 = Date.now()
  const r = spawnSync(process.execPath, ['--no-warnings', join('pruebas', nombre)], {
    cwd: ROOT,
    env: entorno,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: TOPE_MS
  })
  const salida = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const seg = ((Date.now() - t0) / 1000).toFixed(1)
  writeFileSync(join(carpetaLogs, nombre.replace(/\.test\.mjs$/, '') + '.log'), salida)
  const codigo = r.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : (r.status ?? 'señal')
  if (codigo === 0) {
    console.log(`${etiqueta} exit=0 ${seg}s | ${resumenDe(salida)}`)
  } else {
    fallaron++
    const tipo = tipoDeErrorDe(salida)
    console.log(`${etiqueta} exit=${codigo} ${seg}s | FALLÓ${tipo ? ' (' + tipo + ')' : ''}; el detalle está en los registros sellados`)
  }
})

console.log('')
console.log(fallaron === 0 ? `${pruebas.length} de ${pruebas.length} pruebas pasan.` : `${fallaron} de ${pruebas.length} pruebas fallaron.`)
process.exit(fallaron === 0 ? 0 : 1)
