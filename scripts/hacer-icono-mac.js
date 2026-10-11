/* Genera los iconos de macOS de Bancada: build/icon.icns (programa),
   build/archivo.icns (documentos .bancada) y build/icon.png (1024 x 1024).

   Uso, desde la raíz del proyecto:
     env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/hacer-icono-mac.js [carpeta-de-salida]

   POR QUÉ NO SE USA pruebas/hacer-icono.js: ese script captura la ventana con
   capturePage, que devuelve píxeles = tamaño x factor de escala de la pantalla
   donde se corre. Con la pantalla al 125 % el "1024" sale de 320 px, y
   electron-builder rechaza un .icns de menos de 512 px (ERR_ICON_TOO_SMALL).
   Acá el dibujo se pasa por un <canvas> de 1024 x 1024 exactos, que no depende
   de la pantalla, y el .icns se arma a mano (cada trozo es un PNG).

   Los .icns se commitean: no corre en el runner, así que no hace falta Electron
   ahí para generarlos. El trazo y los colores son los mismos que usa
   pruebas/hacer-icono.js para los .ico de Windows.                            */
'use strict';

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

app.on('window-all-closed', () => {});

const SALIDA = path.resolve(process.argv[2] || path.join(__dirname, '..', 'build'));

const PAPEL = '#FAF7F2';
const AMBAR = '#C96A12';
const LINEA = '#EDC79B';
const TINTA_3 = '#7A7167';
const MARCA = 'M3 17h18M6 17V9l6-4 6 4v8M9 17v-4h6v4';

const svgPrograma = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${PAPEL}"/><stop offset="1" stop-color="#F1EBE0"/></linearGradient></defs><rect x="0" y="0" width="100" height="100" rx="22" ry="22" fill="url(#g)"/><rect x="1.25" y="1.25" width="97.5" height="97.5" rx="20.9" ry="20.9" fill="none" stroke="${LINEA}" stroke-width="2.5"/><g transform="translate(14 17) scale(3)" fill="none" stroke="${AMBAR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${MARCA}"/></g></svg>`;

const svgArchivo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><path d="M16 6h44l24 24v58a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6V12a6 6 0 0 1 6-6z" fill="${PAPEL}" stroke="${TINTA_3}" stroke-width="3" stroke-linejoin="round"/><path d="M60 6v24h24" fill="none" stroke="${TINTA_3}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><g transform="translate(15.8 33.4) scale(2.6)" fill="none" stroke="${AMBAR}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="${MARCA}"/></g></svg>`;

/* Dibuja el SVG en un lienzo de 1024. `lado` es el tamaño del dibujo y `desde`
   su desplazamiento: el icono del programa usa 824 px con 100 px de margen
   transparente (la plantilla de macOS; sin margen se ve más grande que los
   demás en el Dock) y el del archivo ocupa todo el lienzo. */
async function a1024(win, svg, lado, desde) {
  const js = `new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = 1024; c.height = 1024;
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
      x.drawImage(img, ${desde}, ${desde}, ${lado}, ${lado});
      res(c.toDataURL('image/png'));
    };
    img.onerror = () => rej(new Error('el SVG no cargó'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
  })`;
  const url = await win.webContents.executeJavaScript(js);
  return nativeImage.createFromDataURL(url);
}

/* Formato .icns: cabecera 'icns' + largo total (big endian) y una lista de
   trozos [tipo de 4 letras][largo del trozo][PNG].
   ic07=128, ic08=256, ic09=512, ic10=1024, ic11=16@2x, ic12=32@2x,
   ic13=128@2x, ic14=256@2x. */
function icns(grande) {
  const TIPOS = [['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024]];
  const trozos = TIPOS.map(([tipo, lado]) => {
    const png = (lado === 1024 ? grande : grande.resize({ width: lado, height: lado, quality: 'best' })).toPNG();
    const h = Buffer.alloc(8);
    h.write(tipo, 0, 'ascii');
    h.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([h, png]);
  });
  const total = 8 + trozos.reduce((n, b) => n + b.length, 0);
  const cab = Buffer.alloc(8);
  cab.write('icns', 0, 'ascii');
  cab.writeUInt32BE(total, 4);
  return Buffer.concat([cab, ...trozos]);
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(SALIDA, { recursive: true });
    const win = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { contextIsolation: true } });
    await win.loadURL('data:text/html,<!doctype html><meta charset=utf-8>');
    const prog = await a1024(win, svgPrograma, 824, 100);
    fs.writeFileSync(path.join(SALIDA, 'icon.png'), prog.toPNG());
    fs.writeFileSync(path.join(SALIDA, 'icon.icns'), icns(prog));
    const arch = await a1024(win, svgArchivo, 1024, 0);
    fs.writeFileSync(path.join(SALIDA, 'archivo.icns'), icns(arch));
    console.log('ok', SALIDA, prog.getSize());
    app.exit(0);
  } catch (e) {
    console.error('falló', e);
    app.exit(1);
  }
});
