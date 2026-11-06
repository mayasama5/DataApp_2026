// Ejecuta la prueba en una base temporal y un navegador independiente.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const runtime = process.env.DATAAPP_RUNTIME;
const { homedir } = require('node:os');
const { chromium } = require(path.join(runtime, 'node/node_modules/playwright'));
const temporal = fs.mkdtempSync(path.join(process.cwd(), '.qa-'));
const server = spawn(path.join(runtime, 'python/python.exe'), ['-u', '-c',
  'import sys, pathlib, almacenamiento; almacenamiento.BASE=pathlib.Path(sys.argv[1])/"test.sqlite3"; from abrir_dataapp import crear_servidor; s=crear_servidor(0); print(s.server_port, flush=True); s.serve_forever()', temporal], {
  env: { ...process.env, DATAAPP_EXCEL_DIR: path.join(homedir(), 'Downloads'), DATAAPP_ESCRIBIR_EXCEL: '0' },
});

async function probar() {
  const puerto = await new Promise((resolve, reject) => {
    const limite = setTimeout(() => reject(new Error('No se inició el servidor de prueba.')), 20000);
    server.once('exit', code => { clearTimeout(limite); reject(new Error(`Servidor cerrado: ${code}`)); });
    server.stdout.once('data', data => { clearTimeout(limite); resolve(Number(data.toString().trim())); });
    server.stderr.on('data', () => {});
  });
  const audioPrueba = process.env.DATAAPP_AUDIO_PRUEBA;
  const args = audioPrueba ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${audioPrueba}`] : [];
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args });
  try {
    const contexto = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await contexto.newPage();
    async function abrirEdicion(nombre, anio = 2026) {
      await page.locator('#ferias button').filter({ hasText: nombre }).click();
      assert.equal(await page.locator('#cartera').isHidden(), true);
      assert.equal(await page.locator('#pendientes').isHidden(), true);
      await page.getByRole('heading', { name: '2027', exact: true }).waitFor();
      await page.getByRole('button', { name: `Abrir ${anio}`, exact: true }).click();
      await page.locator('#cartera').waitFor();
      await page.locator('#pendientes').waitFor();
    }
    await page.addInitScript(() => {
      window.SpeechRecognition = class {
        start() {
          setTimeout(() => {
            this.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'Texto dictado de prueba' } }] });
            this.onend();
          }, 5);
        }
        abort() { this.onend(); }
      };
    });
    const errores = [];
    page.on('pageerror', error => errores.push(error.message));
    await page.goto(`http://127.0.0.1:${puerto}/`);
    await page.getByRole('heading', { name: 'Creá tu cuenta administradora' }).waitFor();
    await page.waitForFunction(() => document.querySelector('.presentacion .marca img').naturalWidth === 192);
    assert.match(await page.title(), /^DataApp /);
    if (process.env.DATAAPP_CAPTURAS) await page.screenshot({ path: path.join(process.env.DATAAPP_CAPTURAS, 'data-app-ingreso.png'), fullPage: true });
    await page.locator('#nombre-usuario').fill('María Consultora');
    await page.locator('#email').fill('maria@prueba.test');
    await page.locator('#password').fill('Prueba-DataApp-2026');
    await page.locator('#ingresar').click();
    await page.locator('#ferias button').first().waitFor();
    assert.equal(await page.locator('#ferias button').count(), 2);
    await page.locator('#actualizar-bases').click();
    await page.getByText('Bases actualizadas desde las planillas. Los contactos, las visitas y las ediciones de DataApp se conservaron.').waitFor();
    if (process.env.DATAAPP_CAPTURAS) await page.screenshot({ path: path.join(process.env.DATAAPP_CAPTURAS, 'data-app-ferias.png'), fullPage: true });
    assert.equal(await page.locator('#cartera').isHidden(), true);
    await abrirEdicion('Feria San Pedro');
    await page.waitForFunction(() => document.querySelectorAll('#empresas tr').length === 150);
    await page.locator('#buscar').fill('Oro Verde');
    assert.equal(await page.locator('#empresas button').count(), 1);
    await page.getByRole('button', { name: 'Abrir ficha de Oro Verde', exact: true }).click();
    await page.locator('#ficha-resumen').waitFor();
    assert.equal(await page.locator('#ficha-editor').isHidden(), true);
    await page.locator('#abrir-edicion').click();
    await page.locator('#campo-0').waitFor();
    if (audioPrueba) {
      await contexto.grantPermissions(['microphone']);
      await page.locator('#editar').getByRole('button', { name: 'Dictar observación', exact: true }).click();
      const detener = page.getByRole('button', { name: 'Detener y transcribir', exact: true });
      await detener.waitFor();
      await page.waitForTimeout(6000);
      await detener.click();
      await page.waitForFunction(() => {
        const campo = [...document.querySelectorAll('#campos textarea')].find(entrada =>
          entrada.labels?.[0]?.textContent === 'OBSERVACIONES');
        return campo?.value.includes('visita fue realizada');
      }, null, { timeout: 25000 });
    }
    assert.equal(await page.locator('#campos > .campo').count(), 24);
    const adherente = page.getByLabel('Adherente / parcería', { exact: true });
    assert.equal(await adherente.inputValue(), '');
    await adherente.selectOption('true');
    const consultores = page.getByRole('group', { name: 'CONSULTOR', exact: true });
    for (const casilla of await consultores.getByRole('checkbox').all()) {
      if (await casilla.isChecked()) await casilla.uncheck();
    }
    for (const nombre of ['Sandra', 'Sofía', 'Helio']) await consultores.getByLabel(nombre, { exact: true }).check();
    assert.equal(await consultores.getByLabel('Maga', { exact: true }).isDisabled(), true);
    await page.getByLabel('Datapar Facturae', { exact: true }).check();
    await page.getByLabel('Clover CRM', { exact: true }).check();
    await page.getByLabel('SDR', { exact: true }).selectOption('Vanessa');
    await page.getByLabel('FECHA', { exact: true }).fill('2026-11-05');
    await page.getByLabel('Follow up', { exact: true }).check();
    await page.getByLabel('Entrega de regalos', { exact: true }).check();
    await page.getByLabel('OBSERVACIONES', { exact: true }).fill('Seguimiento comercial de prueba');
    await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click();
    await page.getByText('Cambios guardados. Tu nombre y la fecha quedaron en el historial.').waitFor();
    assert.match(await page.locator('#resumen-datos').innerText(), /Seguimiento comercial de prueba/);
    await page.locator('#abrir-edicion').click();
    assert.equal(await consultores.getByLabel('Sofía', { exact: true }).isChecked(), true);
    assert.equal(await page.getByLabel('FECHA', { exact: true }).inputValue(), '2026-11-05');
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await contexto.setOffline(true);
    await page.locator('#tab-contacto').click();
    await page.locator('#contacto-nombre').fill('Lucía Nuevo Contacto');
    await page.locator('#contacto-email').fill('lucia@prueba.test');
    await page.getByRole('button', { name: 'Guardar contacto', exact: true }).click();
    await page.getByText('Registro guardado en este dispositivo. Pendiente de sincronización.', { exact: true }).waitFor();
    assert.match(await page.locator('#resumen-contactos').innerText(), /María Consultora/);
    await page.locator('#abrir-edicion').click();
    await page.locator('#tab-actividad').click();
    await page.locator('#notas').fill('Visita sin conexión a internet');
    await page.locator('#actividad').getByRole('button', { name: 'Dictar observación' }).click();
    await page.waitForFunction(() => document.querySelector('#notas').value.includes('Texto dictado de prueba'));
    await page.getByRole('button', { name: 'Guardar actividad', exact: true }).click();
    await page.getByText('Registro guardado en este dispositivo. Pendiente de sincronización.', { exact: true }).waitFor();
    await page.getByText('Sin conexión · 2 pendiente(s)', { exact: true }).waitFor();
    assert.match(await page.locator('#resumen-visitas').innerText(), /REALIZADO/);
    await page.locator('#cerrar').click();
    await page.locator('#buscar').fill('Lucía Nuevo Contacto');
    assert.equal(await page.locator('#empresas button').count(), 1);
    await page.reload();
    await page.locator('#ferias button').first().waitFor();
    await abrirEdicion('Feria San Pedro');
    await page.locator('#buscar').fill('Oro Verde');
    await page.getByRole('button', { name: 'Abrir ficha de Oro Verde', exact: true }).click();
    await page.locator('#ficha-resumen').waitFor();
    assert.match(await page.locator('#resumen-datos').innerText(), /Seguimiento comercial de prueba/);
    assert.match(await page.locator('#resumen-contactos').innerText(), /Lucía Nuevo Contacto/);
    await page.locator('#cerrar').click();
    await contexto.setOffline(false);
    await page.getByText('Con conexión', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Abrir ficha de Oro Verde', exact: true }).click();
    await page.locator('#ficha-resumen').waitFor();
    assert.match(await page.locator('#resumen-visitas').innerText(), /Visita sin conexión a internet Texto dictado de prueba/);
    assert.doesNotMatch(await page.locator('#resumen-visitas').innerText(), /Pendiente de sincronización/);
    await page.locator('#abrir-edicion').click();
    await page.locator('#tab-contacto').click();
    await page.locator('#registro-contacto').selectOption({ label: 'Lucía Nuevo Contacto' });
    await page.locator('#contacto-cargo').fill('Compras');
    await page.getByRole('button', { name: 'Guardar contacto' }).click();
    await page.getByText('Contacto guardado con tu nombre y fecha.').waitFor();
    assert.match(await page.locator('#resumen-contactos').innerText(), /Compras/);
    await page.locator('#cerrar').click();
    const descarga = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Exportar Excel' }).click();
    const archivo = await descarga;
    assert.equal(archivo.suggestedFilename(), 'san-pedro-2026.xlsx');
    const rutaExcel = path.join(temporal, archivo.suggestedFilename());
    await archivo.saveAs(rutaExcel);
    await page.locator('#importar').setInputFiles(rutaExcel);
    await page.getByText(/Importación completada/).waitFor();
    await page.locator('#inicio').click();
    await abrirEdicion('Expo Paraguay Brasil');
    await page.waitForFunction(() => document.querySelectorAll('#empresas tr').length === 166);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#empresas button').first().click();
    await page.locator('#ficha-resumen').waitFor();
    await page.locator('#abrir-edicion').click();
    await page.locator('#campo-0').waitFor();
    assert.equal(await page.locator('#campos > .campo').count(), 23);
    if (process.env.DATAAPP_CAPTURAS) await page.screenshot({ path: path.join(process.env.DATAAPP_CAPTURAS, 'data-app-movil.png') });
    await page.locator('#cerrar').click();
    await page.locator('#inicio').click();
    await abrirEdicion('Feria San Pedro');
    await page.locator('#pendientes').click();
    await page.getByRole('heading', { name: 'Mis pendientes', exact: true }).waitFor();
    await page.locator('#buscar').fill('Oro Verde');
    assert.equal(await page.getByRole('button', { name: 'Abrir ficha de Oro Verde', exact: true }).count(), 0);
    await page.locator('#cartera').click();
    await page.getByRole('heading', { name: 'Mi cartera', exact: true }).waitFor();
    await page.locator('#buscar').fill('Oro Verde');
    await page.getByRole('button', { name: 'Abrir ficha de Oro Verde', exact: true }).waitFor();
    await page.locator('#inicio').click();
    await page.locator('#agregar-feria').click();
    await page.locator('#feria-nombre-nueva').fill('Feria adicional');
    await page.getByRole('button', { name: 'Crear feria', exact: true }).click();
    await page.getByRole('heading', { name: 'Feria adicional', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Exportar Excel' }).waitFor();
    await page.locator('#editar-feria').click();
    await page.locator('#feria-nombre-editar').fill('Feria adicional editada');
    await page.getByRole('button', { name: 'Guardar feria', exact: true }).click();
    await page.getByRole('heading', { name: 'Feria adicional editada', exact: true }).waitFor();
    page.once('dialog', dialogo => dialogo.accept());
    await page.locator('#eliminar-feria').click();
    await page.getByText('Feria archivada. Sus registros se conservaron.').waitFor();
    await page.locator('#ferias-archivadas').click();
    await page.getByRole('button', { name: 'Restaurar', exact: true }).click();
    await page.getByText('Feria restaurada.', { exact: true }).waitFor();
    await page.locator('#usuarios').click();
    await page.locator('#equipo-nombre').fill('Sandra de prueba');
    await page.locator('#equipo-correo').fill('sandra@prueba.test');
    await page.locator('#equipo-clave').fill('Prueba-Sandra-2026');
    await page.locator('#nuevo-asignacion').fill('Sandra');
    await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click();
    await page.getByText('Cuenta creada. Ya puede ingresar con su correo y contraseña.').waitFor();
    await page.locator('#salir').click();
    await page.locator('#email').waitFor({ state: 'visible' });
    await page.locator('#nombre-usuario').fill('Sandra de prueba');
    await page.locator('#email').fill('sandra@prueba.test');
    await page.locator('#login-rol').selectOption('consultor');
    await page.locator('#password').fill('Prueba-Sandra-2026');
    await page.locator('#ingresar').click();
    await page.locator('#ferias button').first().waitFor();
    await abrirEdicion('Feria San Pedro');
    await page.waitForFunction(() => document.querySelectorAll('#empresas tr').length === 150);
    assert.equal(await page.locator('#exportar').isHidden(), true);
    await page.locator('#cartera').click();
    await page.getByRole('heading', { name: 'Mi cartera', exact: true }).waitFor();
    await page.locator('#buscar').fill('Oro Verde');
    await page.getByRole('button', { name: 'Abrir ficha de Oro Verde', exact: true }).click();
    await page.locator('#ficha-resumen').waitFor();
    assert.match(await page.locator('#resumen-contactos').innerText(), /Lucía Nuevo Contacto/);
    assert.equal(await page.getByRole('button', { name: 'Editar Lucía Nuevo Contacto', exact: true }).count(), 0);
    await page.locator('#abrir-edicion').click();
    assert.equal(await page.locator('#tab-datos').isHidden(), true);
    assert.equal(await page.locator('#registro-contacto option').count(), 1);
    await page.locator('#contacto-nombre').fill('Contacto propio de Sandra');
    await page.getByRole('button', { name: 'Guardar contacto' }).click();
    await page.getByText('Contacto guardado con tu nombre y fecha.').waitFor();
    await page.getByRole('button', { name: 'Editar Contacto propio de Sandra', exact: true }).click();
    assert.equal(await page.locator('#contacto-nombre').inputValue(), 'Contacto propio de Sandra');
    await page.locator('#contacto-cargo').fill('Operaciones');
    await page.getByRole('button', { name: 'Guardar contacto' }).click();
    await page.getByText('Contacto guardado con tu nombre y fecha.').waitFor();
    assert.match(await page.locator('#resumen-contactos').innerText(), /Operaciones/);
    await contexto.setOffline(true);
    await page.locator('#abrir-edicion').click();
    await page.locator('#contacto-nombre').fill('Contacto pendiente');
    await page.getByRole('button', { name: 'Guardar contacto' }).click();
    await page.getByText('Registro guardado en este dispositivo. Pendiente de sincronización.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Editar Contacto pendiente', exact: true }).click();
    await page.locator('#contacto-nombre').fill('Contacto pendiente corregido');
    await page.getByRole('button', { name: 'Guardar contacto' }).click();
    await page.getByRole('button', { name: 'Eliminar Contacto pendiente corregido', exact: true }).waitFor();
    page.once('dialog', dialogo => dialogo.accept());
    await page.getByRole('button', { name: 'Eliminar Contacto pendiente corregido', exact: true }).click();
    await page.getByText('Eliminación guardada en este dispositivo. Pendiente de sincronización.', { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('#resumen-contactos').innerText(), /Contacto pendiente corregido/);
    await contexto.setOffline(false);
    await page.getByText('Con conexión', { exact: true }).waitFor();
    await page.locator('#cerrar').click();
    await page.locator('#registro-actividad').click();
    await page.locator('#auditoria-lista').getByText('Contacto agregado', { exact: true }).first().waitFor();
    assert.equal(await page.locator('#auditoria-lista').getByText('Contacto agregado', { exact: true }).count(), 2);
    await page.locator('#auditoria-lista').getByText('Contacto eliminado', { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('#auditoria-lista').innerText(), /María Consultora/);
    await page.locator('#pendientes').click();
    await page.getByRole('heading', { name: 'Mi checklist', exact: true }).waitFor();
    await page.locator('#tarea-titulo').fill('Confirmar reunión de prueba');
    await page.locator('#tarea-fecha').fill('2026-11-06');
    await page.locator('#tarea-hora').fill('14:30');
    await page.getByRole('button', { name: 'Agregar tarea', exact: true }).click();
    const tarea = page.getByRole('checkbox', { name: 'Confirmar reunión de prueba', exact: true });
    await tarea.waitFor();
    await contexto.setOffline(true);
    await tarea.check();
    await page.getByText('Cambio guardado en este dispositivo. Pendiente de sincronización.', { exact: true }).waitFor();
    await contexto.setOffline(false);
    await page.getByText('Con conexión', { exact: true }).waitFor();
    assert.equal(await tarea.isChecked(), true);
    await page.getByRole('button', { name: 'Agregar checklist', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Preparar el material de la visita', exact: true }).waitFor();
    assert.equal(await page.locator('#lista-tareas input[type="checkbox"]').count(), 4);
    await page.locator('#cartera').click();
    await page.getByRole('heading', { name: 'Mi cartera', exact: true }).waitFor();
    await page.locator('#buscar').fill('Oro Verde');
    await page.getByRole('button', { name: 'Abrir ficha de Oro Verde', exact: true }).waitFor();
    const direccion = `http://127.0.0.1:${puerto}`;
    const marketing = await browser.newContext();
    try {
      const headers = { Origin: direccion };
      const login = await marketing.request.post(`${direccion}/api/login`, {
        headers, data: { email: 'maria@prueba.test', password: 'Prueba-DataApp-2026', role: 'marketing' },
      });
      assert.equal(login.ok(), true);
      const eventos = await (await marketing.request.get(`${direccion}/api/events`)).json();
      const sanPedro = eventos.find(feria => feria.id === 'san-pedro-2026');
      const empresas = await (await marketing.request.get(`${direccion}/api/companies?event=${sanPedro.id}`)).json();
      const oro = empresas.find(empresa => empresa.values[0] === 'Oro Verde');
      const index = sanPedro.columns.indexOf('CONSULTOR');
      const cambio = await marketing.request.post(`${direccion}/api/company/${oro.id}`, {
        headers, data: { kind: 'edit', changes: [{ index, before: oro.values[index], after: 'Caio, Mauricio' }] },
      });
      assert.equal(cambio.ok(), true);
      await page.getByRole('button', { name: 'Abrir ficha de Oro Verde', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
      assert.equal(await page.locator('#buscar').inputValue(), 'Oro Verde');
    } finally { await marketing.close(); }
    assert.deepEqual(errores, []);
    console.log(`Edge: edición directa por autor, edición y eliminación pendientes, bitácora, Excel${audioPrueba ? ' y dictado local en español' : ''} verificados.`);
  } finally { await browser.close(); }
}

probar().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  const detenido = new Promise(resolve => server.once('exit', resolve));
  server.kill();
  await detenido;
  fs.rmSync(temporal, { recursive: true });
});
