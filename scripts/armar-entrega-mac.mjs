#!/usr/bin/env node
/**
 * Arma la carpeta "Entrega Mac" con los dos .dmg firmados y notarizados, con los
 * nombres que ve el comprador.
 *
 *   node scripts/armar-entrega-mac.mjs      # o `npm run entrega:mac`
 *
 * Corre en el runner, después de `build:mac`. La carpeta resultante se sella y se
 * sube como artefacto; en la máquina de desarrollo se abre y va al lado de la
 * entrega de Windows.
 *
 * Los nombres son sólo ASCII a propósito: tar en macOS y en Windows no se ponen de
 * acuerdo con la normalización de los acentos (NFC contra NFD) y un nombre con
 * tildes puede llegar partido en dos archivos.
 *
 * Corta si no hay exactamente dos .dmg, uno por arquitectura, o si alguno pesa
 * tan poco que no puede ser la aplicación entera.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ORIGEN = join(ROOT, 'dist')
const DESTINO = join(ROOT, 'Entrega Mac')
const MIN_BYTES = 50 * 1024 * 1024

const NOMBRES = [
  { patron: /-macOS-arm64\.dmg$/, nombre: 'Bancada - Mac con chip Apple (M1, M2, M3, M4).dmg' },
  { patron: /-macOS-x64\.dmg$/, nombre: 'Bancada - Mac con Intel.dmg' }
]

function falla(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

if (!existsSync(ORIGEN)) falla('No existe dist/: corré primero "npm run build:mac".')

const dmgs = readdirSync(ORIGEN).filter((f) => f.endsWith('.dmg'))
if (dmgs.length !== 2) falla(`Tiene que haber exactamente dos .dmg en dist/ y hay ${dmgs.length}: ${dmgs.join(', ') || 'ninguno'}.`)

// No se borra la carpeta entera: la guía del comprador (un PDF que no viaja en
// el repo) puede estar al lado. Sólo se pisan los dos instaladores esperados.
mkdirSync(DESTINO, { recursive: true })
for (const { nombre } of NOMBRES) rmSync(join(DESTINO, nombre), { force: true })

for (const { patron, nombre } of NOMBRES) {
  const coincidencias = dmgs.filter((f) => patron.test(f))
  if (coincidencias.length !== 1) falla(`Esperaba un .dmg que coincida con ${patron} y encontré ${coincidencias.length}.`)
  const origen = join(ORIGEN, coincidencias[0])
  const bytes = statSync(origen).size
  if (bytes < MIN_BYTES) falla(`${coincidencias[0]} pesa ${(bytes / 1048576).toFixed(1)} MB: es demasiado chico para ser la aplicación.`)
  copyFileSync(origen, join(DESTINO, nombre))
  console.log(`✓ ${nombre} (${(bytes / 1048576).toFixed(1)} MB)`)
}

const finales = readdirSync(DESTINO).filter((f) => f.endsWith('.dmg'))
if (new Set(finales).size !== 2) falla('Los dos archivos de la entrega quedaron con el mismo nombre.')
console.log(`✓ Entrega Mac lista: ${finales.length} instaladores`)
