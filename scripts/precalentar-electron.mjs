#!/usr/bin/env node
/**
 * Baja ANTES de compilar, con reintentos, lo que electron-builder baja en medio del
 * build de Mac sin reintentar:
 *
 *   · Electron para las dos arquitecturas (darwin-arm64 y darwin-x64)
 *   · la herramienta que arma el .dmg (dmgbuild), la de la arquitectura del runner
 *
 *   node scripts/precalentar-electron.mjs
 *
 * ---------------------------------------------------------------------------
 * Por qué existe
 * ---------------------------------------------------------------------------
 *
 * electron-builder baja esos archivos de los releases de GitHub, una vez por
 * arquitectura, y un "504 Gateway Time-out" del CDN corta todo. En Mediflashy pasó
 * dos veces seguidas, la segunda DESPUÉS de haber firmado y notarizado el .app de
 * Apple Silicon: se tiró trabajo hecho.
 *
 * electron-builder usa @electron/get con su caché por defecto, y si el zip ya está
 * ahí no sale a la red. Este script lo pone ahí con el mismo @electron/get y la
 * misma versión, reintentando con espera creciente. Junto con la caché del
 * workflow, en las corridas siguientes ni siquiera hace falta bajarlo.
 *
 * Lo de Electron CORTA si no se pudo (sin eso no hay build). Lo de dmgbuild es
 * best-effort: su URL y sus sumas viven dentro de dmg-builder y no son una API
 * pública, así que se leen de su código y, si cambió la forma, se avisa y se sigue:
 * en ese caso lo baja electron-builder en el build, como siempre.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(ROOT, 'package.json'))

// @electron/get es sólo ESM: se carga con import() desde la ruta que resuelve el
// propio proyecto, así usa EXACTAMENTE la misma copia que electron-builder.
const rutaGet = require.resolve('@electron/get')
const { downloadArtifact } = await import(pathToFileURL(rutaGet).href)
const version = require('electron/package.json').version

const INTENTOS = 6
const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

/** Corre `tarea` hasta INTENTOS veces con espera creciente. Devuelve su resultado o lanza el último error. */
async function conReintentos(etiqueta, tarea) {
  for (let intento = 1; ; intento++) {
    try {
      return await tarea()
    } catch (e) {
      if (intento >= INTENTOS) throw new Error(`${etiqueta}: ${INTENTOS} intentos fallidos (${e.message})`)
      const espera = 15 * intento
      console.log(`  ${etiqueta}: intento ${intento} falló (${e.message}); reintento en ${espera} s`)
      await dormir(espera * 1000)
    }
  }
}

for (const arch of ['arm64', 'x64']) {
  try {
    const ruta = await conReintentos(`Electron ${version} darwin-${arch}`, () =>
      downloadArtifact({ version, platform: 'darwin', arch, artifactName: 'electron' })
    )
    console.log(`✓ Electron ${version} darwin-${arch} en la caché: ${ruta}`)
  } catch (e) {
    console.error(`✗ No se pudo bajar ${e.message}`)
    process.exit(1)
  }
}

/* ------------------------------- dmgbuild -------------------------------- */

try {
  const dmgUtil = join(dirname(require.resolve('dmg-builder/package.json')), 'out', 'dmgUtil.js')
  const fuente = readFileSync(dmgUtil, 'utf8')
  const release = fuente.match(/releaseName:\s*"([^"]+)"/)?.[1]
  const plantilla = fuente.match(/filenameWithExt:\s*`([^`]+)`/)?.[1]
  const sumas = Object.fromEntries([...fuente.matchAll(/"(dmgbuild-bundle-[^"]+\.tar\.gz)":\s*"([0-9a-f]{64})"/g)].map((m) => [m[1], m[2]]))
  if (!release || !plantilla || Object.keys(sumas).length === 0) {
    console.log('· dmgbuild: no reconocí la forma de dmg-builder; lo bajará electron-builder en el build.')
  } else {
    // Misma regla que getDmgVendorPath(): arm64 o x86_64 según el runner.
    const arq = process.arch === 'arm64' ? 'arm64' : 'x86_64'
    const archivo = plantilla.replace('${arch}', arq)
    const { downloadBuilderToolset } = require('app-builder-lib/out/util/electronGet')
    const ruta = await conReintentos(`dmgbuild ${arq}`, () =>
      downloadBuilderToolset({ releaseName: release, filenameWithExt: archivo, checksums: sumas })
    )
    console.log(`✓ dmgbuild (${release}, ${arq}) en la caché: ${ruta}`)
  }
} catch (e) {
  console.log(`· dmgbuild: no se pudo precalentar (${e.message}); lo bajará electron-builder en el build.`)
}
