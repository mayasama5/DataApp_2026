import { camposContacto, claveCampo, crearCampo } from './campos.js';
import { guardarCache, guardarPendiente, iniciarModoOffline, leerCache, pendientesDe, quitarPendiente } from './offline.js';
import { controlDictado, detenerDictado } from './dictado.js';

const $ = (selector) => document.querySelector(selector);
let usuario;
let requiereConfiguracion = false;
let eventos = [];
let eventoActual;
let feriaSeleccionada = '';
let empresas = [];
let empresaActual;
let detalleActual;
let lectoresFicha;
let vistaCatalogo = 'feria';
let paginaActual = 'portada';
let numeroVista = 0;
let actualizandoVista = false;
const roles = { admin: 'Marketing', consultor: 'Consultor de ventas', sdr: 'SDR', marketing: 'Marketing' };
const esMarketing = () => ['admin', 'marketing'].includes(usuario?.role);
let nombresAsignacion = {};
const datosContacto = { 'NOMBRE CONTACTO': 'name', CARGO: 'position', CORREO: 'email', TELEFONO: 'phone' };
let sinConexion = false;
let sincronizacion;

function texto(etiqueta, contenido, clase = '') {
  const elemento = document.createElement(etiqueta);
  elemento.textContent = contenido;
  elemento.className = clase;
  return elemento;
}

function normalizar(valor) {
  return String(valor ?? '').normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
}

function mostrar(valor) {
  if (valor === true) return 'Sí';
  if (valor === false) return 'No';
  return valor === null || valor === '' ? '—' : String(valor);
}

async function api(ruta, cuerpo) {
  let respuesta;
  try {
    respuesta = await fetch(`/api/${ruta}`, cuerpo === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
    });
  } catch {
    throw Object.assign(new Error('No pudimos conectar con DataApp.'), { sinConexion: true });
  }
  if ([502, 503, 504].includes(respuesta.status)) {
    throw Object.assign(new Error('DataApp está temporalmente sin conexión.'), { sinConexion: true });
  }
  const resultado = await respuesta.json();
  if (!respuesta.ok) {
    if (respuesta.status === 401 && usuario) {
      usuario = null;
      await guardarCache('sesion', null).catch(() => {});
      $('#aplicacion').hidden = true;
      $('#acceso').hidden = false;
      $('#rol-ingreso').hidden = false;
      $('#login-rol').disabled = false;
      if ($('#ficha').open) $('#ficha').close();
    }
    throw Object.assign(new Error(resultado.error || 'No pudimos completar la operación.'), { estado: respuesta.status });
  }
  return resultado;
}

function rutaCache(ruta, cuenta = usuario) {
  const ambito = ruta === 'events' || ruta.startsWith('companies?') ? 'ediciones:' : '';
  return `${cuenta.id}:${cuenta.role}:${cuenta.assignment || ''}:${ambito}${ruta}`;
}

async function consultar(ruta, alternativa, registrarConsulta = false) {
  const clave = rutaCache(ruta);
  try {
    const datos = await api(registrarConsulta ? `${ruta}?consulta=1` : ruta);
    sinConexion = false;
    await guardarCache(clave, datos).catch(() => {});
    return datos;
  } catch (error) {
    if (!error.sinConexion) throw error;
    sinConexion = true;
    const datos = await leerCache(clave).catch(() => undefined);
    if (datos === undefined && alternativa === undefined) throw new Error('Este catálogo todavía no está guardado en este dispositivo. Abrilo una vez con conexión.');
    return datos ?? alternativa;
  }
}

async function estadoConexion(mensaje = '') {
  const cantidad = usuario ? (await pendientesDe(usuario.id).catch(() => [])).length : 0;
  $('#conexion').textContent = `${sinConexion ? 'Sin conexión' : 'Con conexión'}${cantidad ? ` · ${cantidad} pendiente(s)` : ''}`;
  $('#sincronizar').hidden = !cantidad;
  $('#sync-estado').textContent = mensaje;
}

function sincronizar() {
  if (!usuario) return Promise.resolve();
  if (sincronizacion) return sincronizacion;
  const cuenta = usuario;
  const usuarioId = cuenta.id;
  sincronizacion = (async () => {
    const cola = await pendientesDe(usuarioId).catch(() => []);
    const bloqueadas = new Set();
    let mensaje = '';
    let tareasEnviadas = false;
    for (const op of cola) {
      const ruta = op.ruta || `company/${op.empresaId}`;
      if (usuario?.id !== usuarioId || bloqueadas.has(ruta)) continue;
      try {
        await api(ruta, { ...op.cuerpo, operationId: op.id, userId: usuarioId });
        const detalle = await api(ruta);
        await guardarCache(rutaCache(ruta, cuenta), detalle);
        await quitarPendiente(op.id);
        sinConexion = false;
        if (ruta.startsWith('tasks')) tareasEnviadas = true;
      } catch (error) {
        if (error.sinConexion) {
          sinConexion = true;
          break;
        }
        if (!usuario) break;
        bloqueadas.add(ruta);
        mensaje = error.estado === 409
          ? `${error.message} Tu registro sigue guardado en este dispositivo y requiere revisión antes de enviarse.`
          : error.message;
      }
    }
    if (tareasEnviadas && usuario?.id === usuarioId && !$('#checklist').hidden && paginaActual === 'catalogo') {
      await cargarTareas().catch(() => {});
    }
    await estadoConexion(mensaje);
  })().finally(() => { sincronizacion = null; });
  return sincronizacion;
}

async function guardarOperacion(cuerpo, ruta) {
  const op = {
    id: crypto.randomUUID(), usuarioId: usuario.id, cuerpo, orden: Date.now(),
    ...(ruta ? { ruta } : { empresaId: empresaActual.id, eventoId: eventoActual.id }),
  };
  await guardarPendiente(op);
  await sincronizar();
  return (await pendientesDe(op.usuarioId)).some(pendiente => pendiente.id === op.id);
}

function estadoVisitaHistorial(actividades, origen) {
  for (const registro of actividades) {
    if (registro.kind === 'visit' && ['REALIZADO', 'PENDIENTE'].includes(registro.details.status)) {
      return { id: registro.id, estado: registro.details.status };
    }
    if (registro.kind === 'edit') {
      const cambio = registro.details.changes.find(item => item.field.trim() === 'STATUS VISITA');
      if (cambio) return { estado: cambio.after };
    }
  }
  return { estado: origen };
}

function proyectar(detalle, pendientes, feria = eventoActual) {
  const valores = [...detalle.values];
  const actividades = [...detalle.activities];
  const indiceEstado = feria.columns.findIndex(columna => columna.trim() === 'STATUS VISITA');
  for (const op of pendientes) {
    const { kind, changes, details, recordId, recordOperationId } = op.cuerpo;
    const coincide = actividad => recordOperationId
      ? actividad.id === recordOperationId || actividad.client_operation_id === recordOperationId
      : recordId && actividad.id === recordId;
    const objetivo = recordId || recordOperationId;
    if (!objetivo && ['contact', 'visit'].includes(kind)
        && actividades.some(actividad => actividad.client_operation_id === op.id)) continue;
    let datos = details;
    if (kind === 'record_delete') {
      const indice = actividades.findIndex(coincide);
      if (indice < 0) continue;
      const ultima = estadoVisitaHistorial(actividades, detalle.sourceVisitStatus);
      const [eliminada] = actividades.splice(indice, 1);
      if (ultima.id === eliminada.id && ultima.estado === valores[indiceEstado]) {
        valores[indiceEstado] = estadoVisitaHistorial(actividades, detalle.sourceVisitStatus ?? null).estado;
      }
      datos = { kind: eliminada.kind, before: eliminada.details, recordId: eliminada.id };
    } else if (kind === 'edit') {
      datos = { changes: changes.map(cambio => ({
        field: feria.columns[cambio.index], before: cambio.before, after: cambio.after,
      })) };
      for (const cambio of changes) valores[cambio.index] = cambio.after;
    } else if (kind === 'visit' && details.status !== 'SEGUIMIENTO'
        && (!objetivo || actividades.some(actividad => coincide(actividad)
          && actividad === actividades.find(item => item.kind === 'visit')))) {
      valores[indiceEstado] = details.status;
    }
    if (objetivo && kind !== 'record_delete') {
      const indice = actividades.findIndex(coincide);
      if (indice >= 0) {
        const actividad = actividades[indice];
        actividades[indice] = { ...actividad, details: { ...actividad.details, ...details }, pending: true };
      }
      continue;
    }
    actividades.unshift({ id: op.id, kind, details: datos, user_id: op.usuarioId,
      author: usuario.name, created_at: op.orden / 1000, pending: true });
  }
  return { ...detalle, values: valores, activities: actividades };
}

iniciarModoOffline();
window.addEventListener('offline', () => { sinConexion = true; estadoConexion(); });
window.addEventListener('online', sincronizar);
window.setInterval(() => { if (!document.hidden) sincronizar(); }, 20000);
$('#sincronizar').addEventListener('click', sincronizar);

async function conEnvio(formulario, mensaje, accion) {
  const boton = formulario.querySelector('button:not([type]), button[type="submit"]');
  boton.disabled = true;
  mensaje.textContent = '';
  try { await accion(); } catch (error) { mensaje.textContent = error.message; }
  finally { boton.disabled = false; }
}

function pantalla(id) {
  paginaActual = id;
  numeroVista++;
  for (const opcion of ['portada', 'ediciones', 'catalogo', 'equipo', 'auditoria']) $(`#${opcion}`).hidden = opcion !== id;
  $('#cartera').hidden = !eventoActual;
  $('#pendientes').hidden = !eventoActual;
  const seleccionado = {
    portada: 'inicio', ediciones: 'inicio', catalogo: vistaCatalogo === 'feria' ? 'inicio' : vistaCatalogo,
    equipo: 'usuarios', auditoria: 'registro-actividad',
  }[id];
  for (const nav of document.querySelectorAll('.lateral .nav')) {
    if (nav.id === seleccionado) nav.setAttribute('aria-current', 'page');
    else nav.removeAttribute('aria-current');
  }
  $('#mensaje').textContent = '';
}

async function iniciarEspacio() {
  eventos = await consultar('events');
  nombresAsignacion = esMarketing() ? await consultar('assignments', {}) : {};
  await guardarCache('sesion', usuario).catch(() => {});
  $('#acceso').hidden = true;
  $('#aplicacion').hidden = false;
  $('#usuario').textContent = usuario.name;
  $('#iniciales').textContent = usuario.name.slice(0, 1).toUpperCase();
  $('#rol').textContent = roles[usuario.role];
  $('#usuarios').hidden = !esMarketing();
  $('#actualizar-bases').hidden = !esMarketing();
  $('#agregar-feria').hidden = !esMarketing();
  $('#ferias-archivadas').hidden = !esMarketing();
  $('#lista-archivadas').hidden = true;
  $('#nueva-feria').hidden = true;
  $('#password').value = '';
  mostrarPortada();
  abrirInicio();
  await estadoConexion();
  if (!sinConexion) {
    const cuenta = usuario;
    const rutas = ['tasks', ...eventos.filter(evento => evento.accessible)
      .map(evento => `companies?event=${encodeURIComponent(evento.id)}`)];
    Promise.allSettled(rutas.map(ruta => api(ruta).then(datos => guardarCache(rutaCache(ruta, cuenta), datos))))
      .then(() => sincronizar());
  }
}

function mostrarPortada() {
  const nombres = [...new Map(eventos.map(feria => [claveFeria(feria.name), feria.name])).values()];
  $('#ferias').replaceChildren();
  $('#metricas').replaceChildren();
  for (const [numero, titulo] of [[nombres.length, 'Ferias y eventos'], [eventos.filter(feria => feria.accessible).length, 'Ediciones disponibles']]) {
    const tarjeta = texto('div', '', 'metrica');
    tarjeta.append(texto('strong', numero), texto('span', titulo));
    $('#metricas').append(tarjeta);
  }
  for (const nombre of nombres) {
    const tarjeta = texto('button', '', `feria ${claveFeria(nombre).includes('san pedro') ? 'verde' : 'azul'}`);
    tarjeta.append(texto('span', 'FERIA COMERCIAL', 'etiqueta'), texto('h2', nombre),
      texto('span', 'Ver ediciones →', 'explorar'));
    tarjeta.addEventListener('click', () => mostrarEdiciones(nombre));
    $('#ferias').append(tarjeta);
  }
}

function claveFeria(nombre) {
  return normalizar(nombre).replace(/\s+/g, ' ');
}

function abrirInicio() {
  eventoActual = null;
  feriaSeleccionada = '';
  pantalla('portada');
}

function mostrarEdiciones(nombre) {
  eventoActual = null;
  feriaSeleccionada = nombre;
  const ediciones = eventos.filter(feria => claveFeria(feria.name) === claveFeria(nombre));
  const anios = [...new Set([2026, 2027, ...ediciones.map(feria => feria.year)])].sort();
  $('#ediciones-titulo').textContent = nombre;
  $('#lista-ediciones').replaceChildren();
  for (const anio of anios) {
    const feria = ediciones.find(edicion => edicion.year === anio);
    const tarjeta = texto('article', '', 'panel edicion');
    tarjeta.append(texto('h2', anio));
    if (feria?.accessible) {
      tarjeta.append(texto('p', `${feria.count} registros`, 'ayuda'));
      const abrir = texto('button', `Abrir ${anio}`, 'primario');
      abrir.addEventListener('click', () => abrirEvento(feria).catch(error => { $('#mensaje').textContent = error.message; }));
      tarjeta.append(abrir);
    } else {
      tarjeta.append(texto('p', feria ? 'Tu cuenta no tiene asignaciones en esta edición.' : 'Edición aún sin datos.', 'ayuda'));
      if (!feria && esMarketing()) {
        const crear = texto('button', `Crear edición ${anio}`, 'secundario');
        crear.addEventListener('click', () => prepararFeria(nombre, anio));
        tarjeta.append(crear);
      }
    }
    $('#lista-ediciones').append(tarjeta);
  }
  pantalla('ediciones');
}

$('#login').addEventListener('submit', evento => {
  evento.preventDefault();
  conEnvio(evento.currentTarget, $('#error-login'), async () => {
    const respuesta = await api(requiereConfiguracion ? 'setup' : 'login', Object.fromEntries(new FormData($('#login'))));
    usuario = respuesta.user;
    requiereConfiguracion = false;
    $('#rol-ingreso').hidden = false;
    $('#login-rol').disabled = false;
    $('#login-rol').value = esMarketing() ? 'marketing' : usuario.role;
    $('#password').minLength = 1;
    $('#acceso-titulo').textContent = 'Ingresá a tu espacio';
    $('#acceso-texto').textContent = 'Consultá tus ferias y continuá donde lo dejaste.';
    $('#ingresar').textContent = 'Ingresar a DataApp →';
    await iniciarEspacio();
  });
});

$('#salir').addEventListener('click', async () => {
  try {
    await api('logout', {});
    await guardarCache('sesion', null).catch(() => {});
    usuario = null;
    eventos = [];
    empresas = [];
    $('#aplicacion').hidden = true;
    $('#acceso').hidden = false;
    $('#rol-ingreso').hidden = false;
    $('#login-rol').disabled = false;
    $('#error-login').textContent = '';
  } catch (error) { $('#mensaje').textContent = error.message; }
});
$('#inicio').addEventListener('click', abrirInicio);
$('#volver-ferias').addEventListener('click', abrirInicio);
$('#volver').addEventListener('click', () => {
  if (vistaCatalogo === 'feria') mostrarEdiciones(eventoActual.name);
  else abrirEvento(eventoActual).catch(error => { $('#mensaje').textContent = error.message; });
});
$('#usuarios').addEventListener('click', () => {
  pantalla('equipo');
  cargarCuentas().catch(error => { $('#mensaje').textContent = error.message; });
});
for (const [id, vista] of [['cartera', 'cartera'], ['pendientes', 'pendientes']]) {
  $(`#${id}`).addEventListener('click', () => abrirCartera(vista).catch(error => { $('#mensaje').textContent = error.message; }));
}

function prepararFeria(nombre = '', anio = 2026) {
  abrirInicio();
  $('#nueva-feria').reset();
  $('#nueva-feria-estado').textContent = '';
  $('#feria-nombre-nueva').value = nombre;
  $('#feria-anio-nueva').value = anio;
  $('#nueva-feria').hidden = false;
  $('#feria-nombre-nueva').focus();
}
$('#agregar-feria').addEventListener('click', () => prepararFeria());
$('#cancelar-feria').addEventListener('click', () => { $('#nueva-feria').hidden = true; });
$('#editar-feria').addEventListener('click', () => {
  $('#renombrar-estado').textContent = '';
  $('#feria-nombre-editar').value = eventoActual.name;
  $('#renombrar-feria').hidden = false;
  $('#feria-nombre-editar').focus();
});
$('#cancelar-renombre').addEventListener('click', () => { $('#renombrar-feria').hidden = true; });
$('#renombrar-feria').addEventListener('submit', evento => {
  evento.preventDefault();
  const formulario = evento.currentTarget;
  conEnvio(formulario, $('#renombrar-estado'), async () => {
    const id = eventoActual.id;
    await api(`events/${id}`, { action: 'edit', ...Object.fromEntries(new FormData(formulario)) });
    await iniciarEspacio();
    await abrirEvento(eventos.find(feria => feria.id === id));
    $('#estado-excel').textContent = 'Cambios de la feria guardados.';
  });
});
$('#eliminar-feria').addEventListener('click', async () => {
  const feria = eventoActual;
  if (!window.confirm(`¿Quitar ${feria.name} del listado? Podés restaurarla desde Ferias archivadas.`)) return;
  try {
    await api(`events/${feria.id}`, { action: 'archive' });
    await iniciarEspacio();
    $('#mensaje').textContent = 'Feria archivada. Sus registros se conservaron.';
  } catch (error) { $('#estado-excel').textContent = error.message; }
});

$('#ferias-archivadas').addEventListener('click', async () => {
  const lista = $('#lista-archivadas');
  lista.hidden = false;
  lista.replaceChildren();
  try {
    const ferias = await api('events/archived');
    if (!ferias.length) lista.append(texto('p', 'No hay ferias archivadas.', 'ayuda'));
    for (const feria of ferias) {
      const fila = texto('article', '', 'actividad');
      const boton = texto('button', 'Restaurar', 'secundario');
      boton.addEventListener('click', async () => {
        try {
          await api(`events/${feria.id}`, { action: 'restore' });
          await iniciarEspacio();
          $('#mensaje').textContent = 'Feria restaurada.';
        } catch (error) { $('#mensaje').textContent = error.message; }
      });
      fila.append(texto('strong', `${feria.name} · ${feria.year}`), boton);
      lista.append(fila);
    }
  } catch (error) { $('#mensaje').textContent = error.message; }
});

let siguienteActividad = 0;
async function mostrarActividad(reiniciar = false) {
  if (reiniciar) {
    pantalla('auditoria');
    $('#auditoria-alcance').textContent = esMarketing() ? 'Actividad de todo el equipo' : 'Actividad de tu cuenta';
    $('#auditoria-lista').replaceChildren();
    siguienteActividad = 0;
  }
  const boton = $('#auditoria-mas');
  boton.disabled = true;
  try {
    const pagina = await api(`activity?offset=${siguienteActividad}`);
    for (const item of pagina.items) {
      const fila = texto('article', '', 'actividad');
      const fecha = new Date(item.created_at * 1000).toLocaleString('es-PY');
      fila.append(texto('strong', item.action), texto('small', `${item.author} · ${fecha}`));
      const contexto = [item.event, item.company, item.description].filter(Boolean).join(' · ');
      if (contexto) fila.append(texto('p', contexto));
      $('#auditoria-lista').append(fila);
    }
    if (!siguienteActividad && !pagina.items.length) $('#auditoria-lista').append(texto('p', 'Todavía no hay actividad.', 'ayuda'));
    siguienteActividad += pagina.items.length;
    boton.hidden = !pagina.more;
  } catch (error) { $('#mensaje').textContent = error.message; }
  finally { boton.disabled = false; }
}
$('#registro-actividad').addEventListener('click', () => mostrarActividad(true));
$('#auditoria-mas').addEventListener('click', () => mostrarActividad());
$('#nueva-feria').addEventListener('submit', evento => {
  evento.preventDefault();
  conEnvio(evento.currentTarget, $('#nueva-feria-estado'), async () => {
    const formulario = $('#nueva-feria');
    const datos = Object.fromEntries(new FormData(formulario));
    const archivo = $('#feria-excel-nuevo').files[0];
    const creada = archivo ? await enviarExcel('events', datos, archivo) : await api('events', datos);
    $('#nueva-feria').reset();
    await iniciarEspacio();
    await abrirEvento(eventos.find(feria => feria.id === creada.id));
    $('#estado-excel').textContent = archivo ? 'Edición creada y Excel importado.'
      : 'Edición creada. Importá tu Excel o descargá la plantilla con Exportar Excel.';
  });
});
$('#actualizar-bases').addEventListener('click', async () => {
  const boton = $('#actualizar-bases');
  boton.disabled = true;
  $('#actualizar-estado').textContent = 'Leyendo las planillas de trabajo…';
  try {
    const resultado = await api('refresh', {});
    await iniciarEspacio();
    $('#actualizar-estado').textContent = resultado.conflicts
      ? `Bases actualizadas. ${resultado.conflicts} fichas tienen cambios tanto en Excel como en DataApp. Se conservaron las ediciones de DataApp y se marcaron para revisión.`
      : 'Bases actualizadas desde las planillas. Los contactos, las visitas y las ediciones de DataApp se conservaron.';
  } catch (error) { $('#actualizar-estado').textContent = error.message; }
  finally { boton.disabled = false; }
});
$('#nuevo-usuario').addEventListener('submit', evento => {
  evento.preventDefault();
  conEnvio(evento.currentTarget, $('#equipo-estado'), async () => {
    await api('users', Object.fromEntries(new FormData($('#nuevo-usuario'))));
    nombresAsignacion = await consultar('assignments', {});
    $('#nuevo-usuario').reset();
    cargarPerfil($('#nuevo-perfil'), 'nuevo');
    $('#equipo-estado').textContent = 'Cuenta creada. Ya puede ingresar con su correo y contraseña.';
    await cargarCuentas();
  });
});

function cargarPerfil(contenedor, prefijo, cuenta = { role: 'consultor', assignment: '' }) {
  contenedor.replaceChildren();
  const rol = document.createElement('select');
  rol.id = `${prefijo}-rol`;
  rol.name = 'role';
  for (const clave of ['consultor', 'sdr', 'marketing']) rol.add(new Option(roles[clave], clave));
  rol.value = cuenta.role;
  const etiquetaRol = texto('label', 'Rol');
  etiquetaRol.htmlFor = rol.id;
  const asignacion = document.createElement('input');
  asignacion.id = `${prefijo}-asignacion`;
  asignacion.name = 'assignment';
  asignacion.maxLength = 150;
  asignacion.placeholder = 'Si coincide, podés usar el nombre de la cuenta';
  const etiquetaAsignacion = texto('label', 'Nombre en la planilla');
  etiquetaAsignacion.htmlFor = asignacion.id;
  function opciones() {
    asignacion.disabled = rol.value === 'marketing';
    etiquetaAsignacion.hidden = asignacion.disabled;
    asignacion.hidden = asignacion.disabled;
  }
  rol.addEventListener('change', opciones);
  opciones();
  asignacion.value = cuenta.assignment || '';
  contenedor.append(etiquetaRol, rol, etiquetaAsignacion, asignacion);
}
cargarPerfil($('#nuevo-perfil'), 'nuevo');

async function cargarCuentas() {
  const cuentas = await api('users');
  $('#cuentas-equipo').replaceChildren();
  for (const cuenta of cuentas) {
    const formulario = texto('form', '', 'panel formulario-equipo');
    const perfil = document.createElement('div');
    cargarPerfil(perfil, `equipo-${cuenta.id}`, cuenta);
    const estado = texto('p', '', 'ayuda');
    estado.setAttribute('role', 'status');
    formulario.append(texto('h3', cuenta.name), texto('p', cuenta.email, 'ayuda'), perfil,
      texto('button', 'Guardar permisos', 'secundario'), estado);
    formulario.addEventListener('submit', evento => {
      evento.preventDefault();
      conEnvio(formulario, estado, async () => {
        await api(`users/${cuenta.id}`, Object.fromEntries(new FormData(formulario)));
        nombresAsignacion = await consultar('assignments', {});
        estado.textContent = 'Rol y asignación guardados.';
      });
    });
    $('#cuentas-equipo').append(formulario);
  }
}

async function cargarEmpresas(evento) {
  const registros = await consultar(`companies?event=${encodeURIComponent(evento.id)}`);
  const usandoCache = sinConexion;
  const pendientes = await pendientesDe(usuario.id).catch(() => []);
  return Promise.all(registros.map(async empresa => {
    const operaciones = pendientes.filter(op => op.empresaId === empresa.id);
    const guardada = usandoCache || operaciones.length
      ? await leerCache(rutaCache(`company/${empresa.id}`)).catch(() => undefined) : undefined;
    const base = guardada?.version >= empresa.version ? guardada : empresa;
    const detalle = proyectar({ ...base, activities: base.activities || [] }, operaciones, evento);
    const cacheCompleta = Array.isArray(base.activities);
    return { ...empresa, feria: evento, values: detalle.values, version: detalle.version,
      contactsSearch: [cacheCompleta ? '' : empresa.contactsSearch, contactosParaBuscar(detalle.activities)].join(' ') };
  }));
}

function contactosParaBuscar(actividades) {
  return actividades.filter(registro => registro.kind === 'contact')
    .flatMap(registro => Object.values(registro.details)).join(' ');
}

async function abrirEvento(evento) {
  empresas = await cargarEmpresas(evento);
  eventoActual = evento;
  feriaSeleccionada = evento.name;
  vistaCatalogo = 'feria';
  $('#edicion-actual').textContent = `${evento.name} · ${evento.year}`;
  $('#volver').textContent = '← Elegir año';
  $('#feria-titulo').textContent = evento.name;
  $('#fuente').textContent = `Base de trabajo · ${evento.sheet} · ${evento.columns.length} campos por ficha`;
  $('#buscar').value = '';
  $('#exportar').href = `/api/export?event=${encodeURIComponent(evento.id)}`;
  $('.acciones-excel').hidden = !esMarketing();
  $('#importar-etiqueta').hidden = !esMarketing();
  $('#importar').hidden = !esMarketing();
  $('#estado-excel').textContent = '';
  $('#renombrar-feria').hidden = true;
  $('#checklist').hidden = true;
  $('#visitas-pendientes-titulo').hidden = true;
  pantalla('catalogo');
  listar();
  await estadoConexion();
}

async function abrirCartera(vista) {
  const feria = eventoActual;
  if (!feria) return;
  const registros = await cargarEmpresas(feria);
  if (eventoActual?.id !== feria.id) return;
  empresas = registros.filter(empresa => esMarketing() || empresa.assigned);
  vistaCatalogo = vista;
  $('#edicion-actual').textContent = `${feria.name} · ${feria.year}`;
  $('#volver').textContent = '← Ver empresas de esta edición';
  $('#feria-titulo').textContent = vista === 'pendientes' ? 'Mis pendientes' : 'Mi cartera';
  const asignacion = usuario.role === 'sdr' ? 'SDR' : 'Consultor';
  const textoAsignacion = esMarketing() ? 'Empresas de esta edición' : `Asignadas a ${usuario.assignment || usuario.name} en la columna ${asignacion}`;
  $('#fuente').textContent = `${textoAsignacion}${vista === 'pendientes' ? ' · Visita pendiente' : ''}`;
  $('#buscar').value = '';
  $('.acciones-excel').hidden = true;
  $('#renombrar-feria').hidden = true;
  $('#checklist').hidden = vista !== 'pendientes';
  $('#visitas-pendientes-titulo').hidden = vista !== 'pendientes';
  pantalla('catalogo');
  listar();
  if (vista === 'pendientes') {
    restablecerTarea();
    await cargarTareas().catch(error => { $('#tareas-estado').textContent = error.message; });
  }
  await estadoConexion();
}

async function actualizarVista() {
  if (!usuario || document.hidden || !navigator.onLine || actualizandoVista || $('#ficha').open
      || !['portada', 'ediciones', 'catalogo'].includes(paginaActual)
      || !$('#renombrar-feria').hidden || $('#importar').disabled) return;
  actualizandoVista = true;
  const cuenta = usuario.id;
  const vista = numeroVista;
  const vigente = () => usuario?.id === cuenta && numeroVista === vista && !$('#ficha').open;
  try {
    const ferias = await consultar('events');
    if (!vigente() || sinConexion) return;
    if (JSON.stringify(eventos) !== JSON.stringify(ferias)) {
      eventos = ferias;
      mostrarPortada();
      if (paginaActual === 'ediciones') mostrarEdiciones(feriaSeleccionada);
    }
    if (paginaActual !== 'catalogo') return;
    const feria = ferias.find(item => item.id === eventoActual?.id);
    if (!feria?.accessible) {
      mostrarEdiciones(feriaSeleccionada);
      return;
    }
    const registros = await cargarEmpresas(feria);
    const actuales = vistaCatalogo === 'feria' || esMarketing() ? registros : registros.filter(empresa => empresa.assigned);
    if (vigente()) {
      eventoActual = feria;
      $('#edicion-actual').textContent = `${feria.name} · ${feria.year}`;
      if (vistaCatalogo === 'feria') $('#feria-titulo').textContent = feria.name;
    }
    if (vigente() && JSON.stringify(empresas) !== JSON.stringify(actuales)) {
      empresas = actuales;
      listar();
    }
  } catch {
    // La vista sigue disponible con los datos que ya tenía.
  } finally {
    actualizandoVista = false;
  }
}
window.setInterval(actualizarVista, 10000);
window.addEventListener('focus', actualizarVista);

const plantillasTareas = {
  visita: ['Revisar la ficha de la empresa', 'Confirmar el horario de la visita', 'Preparar el material de la visita'],
  seguimiento: ['Registrar el resultado de la visita', 'Enviar la información acordada', 'Programar el próximo seguimiento'],
};
let tareaEditada;

function restablecerTarea() {
  tareaEditada = null;
  $('#tarea-form').reset();
  $('#tarea-guardar').textContent = 'Agregar tarea';
  $('#tarea-cancelar').hidden = true;
}

function nuevaTarea(title, date, time) {
  return { id: crypto.randomUUID(), title, date, time, done: false, version: 0 };
}

async function cargarTareas() {
  const cuenta = usuario.id;
  const edicion = eventoActual?.id;
  if (!edicion) return;
  const ruta = `tasks?event=${encodeURIComponent(edicion)}`;
  const [guardadas, anteriores] = await Promise.all([consultar(ruta, []), consultar('tasks', [])]);
  const pendientes = await pendientesDe(cuenta).catch(() => []);
  if (usuario?.id !== cuenta || eventoActual?.id !== edicion) return;
  const tareas = new Map(guardadas.map(tarea => [tarea.id, tarea]));
  const antiguas = new Map(anteriores.map(tarea => [tarea.id, tarea]));
  for (const op of pendientes.filter(operacion => operacion.ruta === ruta || operacion.ruta === 'tasks')) {
    for (const cambio of op.cuerpo.changes) {
      const lista = op.ruta === ruta ? tareas : antiguas;
      if (cambio.moverAnterior) antiguas.delete(cambio.id);
      const anterior = lista.get(cambio.id);
      if ((anterior?.version || 0) > cambio.version) continue;
      lista.set(cambio.id, { ...cambio, version: cambio.version + 1, pending: true,
        completed_at: cambio.done ? anterior?.completed_at || op.orden / 1000 : null });
    }
  }
  const lista = $('#lista-tareas');
  lista.replaceChildren();
  const ordenadas = [...tareas.values()].sort((a, b) => Number(a.done) - Number(b.done)
    || (a.date || '9999').localeCompare(b.date || '9999') || a.time.localeCompare(b.time) || a.title.localeCompare(b.title));
  if (!ordenadas.length) lista.append(texto('p', 'Todavía no agregaste tareas.', 'ayuda'));
  for (const tarea of ordenadas) {
    const fila = texto('div', '', 'tarea-fila');
    const info = document.createElement('div');
    const etiqueta = document.createElement('label');
    const casilla = document.createElement('input');
    casilla.type = 'checkbox';
    casilla.checked = tarea.done;
    etiqueta.append(casilla, texto('span', tarea.title, tarea.done ? 'tarea-hecha' : ''));
    info.append(etiqueta);
    const fecha = tarea.date ? `${tarea.date.split('-').reverse().join('/')}${tarea.time ? ` · ${tarea.time}` : ''}` : 'Sin fecha prevista';
    const completada = tarea.completed_at ? `Completada el ${new Date(tarea.completed_at * 1000).toLocaleString('es-PY')}` : '';
    info.append(texto('small', [fecha, completada, tarea.pending ? 'Pendiente de sincronización' : ''].filter(Boolean).join(' · '), 'ayuda'));
    const editar = texto('button', 'Editar', 'secundario');
    editar.type = 'button';
    editar.setAttribute('aria-label', `Editar tarea ${tarea.title}`);
    editar.addEventListener('click', () => {
      tareaEditada = tarea;
      $('#tarea-titulo').value = tarea.title;
      $('#tarea-fecha').value = tarea.date;
      $('#tarea-hora').value = tarea.time;
      $('#tarea-guardar').textContent = 'Guardar cambios';
      $('#tarea-cancelar').hidden = false;
      $('#tarea-titulo').focus();
    });
    casilla.addEventListener('change', async () => {
      casilla.disabled = true;
      try {
        await guardarChecklist([{ ...tarea, done: casilla.checked }], casilla.checked ? 'Tarea completada.' : 'Tarea reabierta.');
      } catch (error) {
        casilla.checked = tarea.done;
        $('#tareas-estado').textContent = error.message;
      } finally { casilla.disabled = false; }
    });
    fila.append(info, editar);
    lista.append(fila);
  }
  $('#tareas-anteriores').hidden = !antiguas.size;
  $('#lista-tareas-anteriores').replaceChildren();
  for (const tarea of antiguas.values()) {
    const fila = texto('div', '', 'tarea-fila');
    const mover = texto('button', 'Incorporar a esta edición', 'secundario');
    mover.addEventListener('click', async () => {
      mover.disabled = true;
      try { await guardarChecklist([{ ...tarea, moverAnterior: true }], 'Tarea incorporada.'); }
      catch (error) { $('#tareas-estado').textContent = error.message; }
      finally { mover.disabled = false; }
    });
    fila.append(texto('span', tarea.title), mover);
    $('#lista-tareas-anteriores').append(fila);
  }
}

async function guardarChecklist(cambios, mensaje) {
  if (cambios.some(tarea => !tarea.title.trim() || (tarea.time && !tarea.date))) {
    throw new Error('Ingresá el nombre de la tarea y elegí una fecha si querés asignarle una hora.');
  }
  if (!eventoActual) throw new Error('Elegí primero una edición de la feria.');
  const pendiente = await guardarOperacion({ changes: cambios }, `tasks?event=${encodeURIComponent(eventoActual.id)}`);
  await cargarTareas();
  $('#tareas-estado').textContent = pendiente ? 'Cambio guardado en este dispositivo. Pendiente de sincronización.' : mensaje;
}

$('#tarea-cancelar').addEventListener('click', restablecerTarea);
$('#tarea-form').addEventListener('submit', evento => {
  evento.preventDefault();
  conEnvio(evento.currentTarget, $('#tareas-estado'), async () => {
    const { title, date, time } = Object.fromEntries(new FormData(evento.currentTarget));
    const tarea = tareaEditada ? { ...tareaEditada, title, date, time } : nuevaTarea(title, date, time);
    await guardarChecklist([tarea], tareaEditada ? 'Cambios guardados.' : 'Tarea agregada.');
    restablecerTarea();
  });
});
$('#tarea-agregar-plantilla').addEventListener('click', async evento => {
  const boton = evento.currentTarget;
  boton.disabled = true;
  try {
    const tareas = plantillasTareas[$('#tarea-plantilla').value]
      .map(titulo => nuevaTarea(titulo, $('#tarea-fecha').value, $('#tarea-hora').value));
    await guardarChecklist(tareas, 'Checklist agregado.');
  } catch (error) { $('#tareas-estado').textContent = error.message; }
  finally { boton.disabled = false; }
});

async function enviarExcel(ruta, parametros, archivo) {
  if (archivo.size > 12 * 1024 * 1024) throw new Error('Elegí un archivo Excel de hasta 12 MB.');
  const respuesta = await fetch(`/api/${ruta}?${new URLSearchParams(parametros)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: archivo,
  });
  const datos = await respuesta.json();
  if (!respuesta.ok) throw new Error(datos.error);
  return datos;
}

$('#importar').addEventListener('change', async evento => {
  const entrada = evento.currentTarget;
  const archivo = entrada.files[0];
  if (!archivo) return;
  const feria = eventoActual;
  entrada.disabled = true;
  $('#estado-excel').textContent = 'Importando la planilla…';
  try {
    const datos = await enviarExcel('import', { event: feria.id }, archivo);
    if (eventoActual.id === feria.id) {
      eventos = await consultar('events');
      await abrirEvento(eventos.find(evento => evento.id === feria.id));
      $('#estado-excel').textContent = `Importación completada. ${datos.conflicts} ficha(s) para revisión.`;
    }
  } catch (error) { $('#estado-excel').textContent = error.message; }
  finally { entrada.value = ''; entrada.disabled = false; }
});

function valorCampo(empresa, nombre) {
  const indice = empresa.feria.columns.findIndex(columna => columna.trim() === nombre);
  return indice < 0 ? null : empresa.values[indice];
}

function listar() {
  const filtro = normalizar($('#buscar').value);
  const disponibles = vistaCatalogo === 'pendientes'
    ? empresas.filter(empresa => normalizar(valorCampo(empresa, 'STATUS VISITA')) === 'pendiente') : empresas;
  const encontrados = disponibles.filter(empresa =>
    empresa.values.some(valor => normalizar(valor).includes(filtro)) || normalizar(empresa.contactsSearch).includes(filtro));
  $('#cantidad').textContent = `${encontrados.length} de ${disponibles.length} registros`;
  const fragmento = document.createDocumentFragment();
  for (const empresa of encontrados) {
    const fila = document.createElement('tr');
    const nombre = texto('td', '');
    const subtitulo = vistaCatalogo === 'feria' ? `Registro ${empresa.row - 1}` : empresa.feria.name;
    nombre.append(texto('strong', mostrar(empresa.values[0])), texto('small', subtitulo, 'fila-secundaria'));
    const standIndice = empresa.feria.columns.findIndex(columna => columna.includes('STAND'));
    const estado = mostrar(valorCampo(empresa, 'STATUS VISITA'));
    const celdaEstado = texto('td', '');
    celdaEstado.append(texto('span', estado, `estado ${/realizado|visitad/i.test(estado) ? 'realizado' : ''}`));
    const accion = texto('td', '');
    const abrir = texto('button', 'Abrir ficha →', 'texto');
    abrir.setAttribute('aria-label', `Abrir ficha de ${mostrar(empresa.values[0])}`);
    abrir.addEventListener('click', () => abrirFicha(empresa).catch(error => { $('#mensaje').textContent = error.message; }));
    accion.append(abrir);
    fila.append(nombre, texto('td', mostrar(valorCampo(empresa, 'RUBRO'))), texto('td', mostrar(valorCampo(empresa, 'CONSULTOR'))), texto('td', mostrar(empresa.values[standIndice])), celdaEstado, accion);
    fragmento.append(fila);
  }
  if (!encontrados.length) {
    const fila = document.createElement('tr');
    const celda = texto('td', vistaCatalogo === 'pendientes' && !disponibles.length
      ? 'No hay empresas con visita pendiente.' : 'No encontramos coincidencias. Probá con otro nombre, contacto o stand.');
    celda.colSpan = 6;
    fila.append(celda);
    fragmento.append(fila);
  }
  $('#empresas').replaceChildren(fragmento);
}
$('#buscar').addEventListener('input', listar);

const seccionesEditor = [['tab-datos', 'seccion-datos'], ['tab-contacto', 'contacto'], ['tab-actividad', 'actividad']];
function seccionFicha(seccion) {
  detenerDictado();
  $('#ficha-resumen').hidden = Boolean(seccion);
  $('#ficha-editor').hidden = !seccion;
  for (const [tab, panel] of seccionesEditor) {
    const activo = panel === seccion;
    $(`#${panel}`).hidden = !activo;
    $(`#${tab}`).classList.toggle('activo', activo);
    $(`#${tab}`).setAttribute('aria-pressed', String(activo));
  }
}
for (const [tab, panel] of seccionesEditor) $(`#${tab}`).addEventListener('click', () => seccionFicha(panel));
$('#abrir-edicion').addEventListener('click', () => seccionFicha(esMarketing() ? 'seccion-datos' : 'contacto'));
$('#volver-resumen').addEventListener('click', () => seccionFicha());
$('#cerrar').addEventListener('click', () => $('#ficha').close());
$('#ficha').addEventListener('close', detenerDictado);
$('#dictado-actividad').append(controlDictado($('#notas')));

function contactoDePlanilla() {
  const details = {};
  eventoActual.columns.forEach((columna, indice) => {
    const clave = datosContacto[claveCampo(columna)];
    if (clave) details[clave] = detalleActual.values[indice] ?? '';
  });
  return Object.values(details).some(Boolean) ? { details, kind: 'contact', author: 'Planilla de la feria' } : null;
}

function tarjetaRegistro(registro, campos, titulo) {
  const tarjeta = texto('article', '', 'actividad');
  tarjeta.append(texto('strong', titulo));
  for (const [clave, etiqueta] of campos) {
    const dato = registro.details[clave];
    if (dato) tarjeta.append(texto('p', `${etiqueta} · ${mostrar(dato)}`));
  }
  const fecha = registro.created_at ? new Date(registro.created_at * 1000).toLocaleString('es-PY') : '';
  tarjeta.append(texto('small', [registro.author, fecha, registro.pending ? 'Pendiente de sincronización' : ''].filter(Boolean).join(' · ')));
  if (puedeModificarRegistro(registro)) {
    const config = formulariosRegistro.find(formulario => formulario.tipo === registro.kind);
    const acciones = texto('div', '', 'acciones-registro');
    const editar = texto('button', 'Editar', 'secundario');
    editar.type = 'button';
    editar.setAttribute('aria-label', `Editar ${titulo}`);
    editar.addEventListener('click', () => {
      seccionFicha(config.id);
      $(`#${config.selector}`).value = String(registro.id);
      cargarRegistro(config);
      $(`#${config.id}`).querySelector('[name]').focus();
    });
    const eliminar = texto('button', 'Eliminar', 'secundario');
    eliminar.type = 'button';
    eliminar.setAttribute('aria-label', `Eliminar ${titulo}`);
    eliminar.addEventListener('click', () => eliminarRegistro(config, registro, eliminar));
    acciones.append(editar, eliminar);
    tarjeta.append(acciones);
  }
  return tarjeta;
}

function columnasDeFicha(columnas) {
  const orden = columnas.map((columna, indice) => ({ columna, indice }));
  const adherente = orden.findIndex(({ columna }) => claveCampo(columna) === 'ADHERENTE?');
  if (adherente < 0) return orden;
  const [campo] = orden.splice(adherente, 1);
  const cliente = orden.findIndex(({ columna }) => claveCampo(columna) === 'CLIENTE?');
  orden.splice(cliente < 0 ? orden.length : cliente + 1, 0, campo);
  return orden;
}

function mostrarFicha() {
  const datos = $('#resumen-datos');
  datos.replaceChildren();
  columnasDeFicha(eventoActual.columns).forEach(({ columna, indice }) => {
    if (camposContacto.includes(claveCampo(columna))) return;
    const par = texto('div', '', /OBSERVACIONES/.test(claveCampo(columna)) ? 'resumen-ancho' : '');
    const titulo = claveCampo(columna) === 'ADHERENTE?' ? 'Adherente / parcería' : columna.trim();
    par.append(texto('dt', titulo), texto('dd', mostrar(detalleActual.values[indice])));
    datos.append(par);
  });
  $('#resumen-estado').textContent = `Estado de visita · ${mostrar(valorCampo(empresaActual, 'STATUS VISITA'))}`;
  const dePlanilla = contactoDePlanilla();
  const contactos = detalleActual.activities.filter(registro => registro.kind === 'contact');
  const visitas = detalleActual.activities.filter(registro => registro.kind === 'visit');
  const resumenContactos = $('#resumen-contactos');
  const resumenVisitas = $('#resumen-visitas');
  resumenContactos.replaceChildren();
  resumenVisitas.replaceChildren();
  for (const registro of [...(dePlanilla ? [dePlanilla] : []), ...contactos]) {
    resumenContactos.append(tarjetaRegistro(registro, [['position', 'Cargo'], ['email', 'Correo'], ['phone', 'Teléfono']],
      registro.details.name || 'Contacto de la planilla'));
  }
  for (const registro of visitas) {
    resumenVisitas.append(tarjetaRegistro(registro, [['nextDate', 'Próximo seguimiento'], ['notes', 'Observaciones']],
      `Visita o seguimiento · ${registro.details.status}`));
  }
  if (!resumenContactos.childElementCount) resumenContactos.append(texto('p', 'Todavía no hay contactos registrados.', 'ayuda'));
  if (!resumenVisitas.childElementCount) resumenVisitas.append(texto('p', 'Todavía no hay visitas o seguimientos registrados en DataApp.', 'ayuda'));
}

const formulariosRegistro = [
  { id: 'contacto', tipo: 'contact', selector: 'registro-contacto', titulo: 'titulo-contacto', nuevo: 'Agregar contacto', editar: 'Editar contacto', eliminar: 'eliminar-contacto' },
  { id: 'actividad', tipo: 'visit', selector: 'registro-visita', titulo: 'titulo-actividad', nuevo: 'Registrar actividad', editar: 'Editar visita o seguimiento', eliminar: 'eliminar-visita' },
];

function puedeModificarRegistro(registro) {
  return Boolean(registro?.id && (esMarketing() || registro.user_id === usuario.id));
}

function referenciaRegistro(registro) {
  return typeof registro.id === 'number' ? { recordId: registro.id } : { recordOperationId: registro.id };
}

function registroElegido(config) {
  const seleccion = $(`#${config.selector}`).value;
  if (seleccion === 'excel') return contactoDePlanilla();
  return detalleActual.activities.find(registro => registro.kind === config.tipo && String(registro.id) === seleccion);
}

function cargarRegistro(config) {
  const formulario = $(`#${config.id}`);
  const elegido = registroElegido(config);
  const valores = elegido?.details || (config.tipo === 'visit' ? { status: 'REALIZADO' } : {});
  for (const campo of formulario.querySelectorAll('[name]')) campo.value = valores[campo.name] ?? '';
  $(`#${config.titulo}`).textContent = elegido ? config.editar : config.nuevo;
  $(`#${config.eliminar}`).hidden = !elegido?.id;
}

function prepararRegistros() {
  for (const config of formulariosRegistro) {
    const selector = $(`#${config.selector}`);
    selector.replaceChildren(new Option(config.nuevo, ''));
    if (esMarketing() && config.tipo === 'contact' && contactoDePlanilla()) selector.add(new Option('Contacto de la planilla', 'excel'));
    for (const registro of detalleActual.activities.filter(registro => registro.kind === config.tipo && puedeModificarRegistro(registro))) {
      const etiqueta = config.tipo === 'contact' ? registro.details.name
        : `${registro.details.status} · ${new Date(registro.created_at * 1000).toLocaleString('es-PY')}`;
      selector.add(new Option(etiqueta, registro.id));
    }
    cargarRegistro(config);
  }
}
for (const config of formulariosRegistro) {
  $(`#${config.selector}`).addEventListener('change', () => {
    detenerDictado();
    cargarRegistro(config);
  });
  $(`#${config.eliminar}`).addEventListener('click', evento =>
    eliminarRegistro(config, registroElegido(config), evento.currentTarget));
}

async function eliminarRegistro(config, registro, boton) {
  if (!puedeModificarRegistro(registro)) return;
  const nombre = config.tipo === 'contact' ? `el contacto ${registro.details.name}` : 'esta visita o seguimiento';
  if (!window.confirm(`¿Eliminar ${nombre} de la ficha?`)) return;
  const empresa = empresaActual;
  boton.disabled = true;
  try {
    detenerDictado();
    const pendiente = await guardarOperacion({ kind: 'record_delete', ...referenciaRegistro(registro), beforeDetails: registro.details });
    await abrirFicha(empresa, false);
    listar();
    $('#ficha-mensaje').textContent = pendiente ? 'Eliminación guardada en este dispositivo. Pendiente de sincronización.'
      : config.tipo === 'contact' ? 'Contacto eliminado.' : 'Visita eliminada.';
  } catch (error) { $('#ficha-mensaje').textContent = error.message; }
  finally { boton.disabled = false; }
}

async function abrirFicha(empresa, registrarConsulta = true) {
  eventoActual = empresa.feria;
  const base = await consultar(`company/${empresa.id}`, { values: empresa.values, version: empresa.version, activities: [] }, registrarConsulta);
  const pendientes = await pendientesDe(usuario.id).catch(() => []);
  const detalle = proyectar(base, pendientes.filter(op => op.empresaId === empresa.id));
  empresaActual = empresa;
  detalleActual = detalle;
  empresa.values = detalle.values;
  empresa.version = detalle.version;
  if (!sinConexion || Object.hasOwn(base, 'sourceVisitStatus') || base.activities.length) {
    empresa.contactsSearch = contactosParaBuscar(detalle.activities);
  } else if (detalle.activities.some(registro => registro.kind === 'contact' && registro.pending)) {
    empresa.contactsSearch = `${empresa.contactsSearch || ''} ${contactosParaBuscar(detalle.activities)}`;
  }
  $('#empresa-nombre').textContent = mostrar(detalle.values[0]);
  $('#ficha-feria').textContent = eventoActual.name;
  $('#ficha-origen').textContent = `${eventoActual.source} · ${eventoActual.sheet} · fila ${empresa.row}`;
  $('#ficha-mensaje').textContent = detalle.importConflict ? 'La planilla cambió y esta ficha tiene ediciones. Se conservaron tus cambios. La actualización requiere revisión.' : '';
  $('#tab-datos').hidden = !esMarketing();
  $('#campos').replaceChildren();
  lectoresFicha = new Map();
  columnasDeFicha(eventoActual.columns).forEach(({ columna, indice }) => {
    if (camposContacto.includes(claveCampo(columna))) return;
    if (!esMarketing()) return;
    const { nodo, leer } = crearCampo(columna, indice, detalle.values[indice], nombresAsignacion);
    const observaciones = nodo.querySelector('textarea');
    if (claveCampo(columna) === 'OBSERVACIONES' && observaciones) nodo.append(controlDictado(observaciones));
    lectoresFicha.set(indice, leer);
    $('#campos').append(nodo);
  });
  mostrarFicha();
  mostrarHistorial(detalle.activities);
  prepararRegistros();
  seccionFicha();
  if (!$('#ficha').open) $('#ficha').showModal();
  await estadoConexion($('#sync-estado').textContent);
}

$('#editar').addEventListener('submit', evento => {
  evento.preventDefault();
  conEnvio(evento.currentTarget, $('#ficha-mensaje'), async () => {
    const cambios = [];
    for (const [indice, leer] of lectoresFicha) {
      const antes = detalleActual.values[indice];
      const despues = leer();
      if (antes !== despues) cambios.push({ index: indice, before: antes, after: despues });
    }
    if (!cambios.length) {
      $('#ficha-mensaje').textContent = 'No hay cambios para guardar.';
      return;
    }
    const pendiente = await guardarOperacion({ kind: 'edit', changes: cambios });
    await abrirFicha(empresaActual, false);
    listar();
    $('#ficha-mensaje').textContent = pendiente ? 'Cambios guardados en este dispositivo. Pendientes de sincronización.' : 'Cambios guardados. Tu nombre y la fecha quedaron en el historial.';
  });
});

for (const config of formulariosRegistro) {
  $(`#${config.id}`).addEventListener('submit', evento => {
    evento.preventDefault();
    const formulario = evento.currentTarget;
    conEnvio(formulario, $('#ficha-mensaje'), async () => {
      const details = Object.fromEntries(new FormData(formulario));
      const kind = config.tipo;
      if (kind === 'contact' && !details.name.trim()) throw new Error('Ingresá el nombre del contacto.');
      const elegido = registroElegido(config);
      let operacion = { kind, details };
      if (elegido?.id) {
        operacion = { ...operacion, ...referenciaRegistro(elegido), beforeDetails: elegido.details };
      } else if (elegido) {
        const changes = eventoActual.columns.flatMap((columna, index) => {
          const campo = datosContacto[claveCampo(columna)];
          const before = detalleActual.values[index];
          const after = details[campo] || null;
          return campo && String(before ?? '') !== String(after ?? '') ? [{ index, before, after }] : [];
        });
        if (!changes.length) throw new Error('No hay cambios para guardar.');
        operacion = { kind: 'edit', changes };
      }
      const pendiente = await guardarOperacion(operacion);
      await abrirFicha(empresaActual, false);
      listar();
      $('#ficha-mensaje').textContent = pendiente ? 'Registro guardado en este dispositivo. Pendiente de sincronización.'
        : kind === 'contact' ? 'Contacto guardado con tu nombre y fecha.' : 'Actividad guardada con tu nombre y fecha.';
    });
  });
}

function mostrarHistorial(actividades) {
  const contenedor = $('#historial');
  contenedor.replaceChildren();
  for (const actividad of actividades) {
    const tarjeta = texto('article', '', 'actividad');
    const fecha = new Date(actividad.created_at * 1000).toLocaleString('es-PY');
    const titulo = { edit: 'Ficha actualizada', contact: 'Contacto agregado', visit: 'Visita registrada',
      record_edit: actividad.details.kind === 'contact' ? 'Contacto actualizado' : 'Visita actualizada',
      record_delete: actividad.details.kind === 'contact' ? 'Contacto eliminado' : 'Visita eliminada' }[actividad.kind];
    tarjeta.append(texto('strong', titulo), texto('small', `${actividad.author} · ${fecha}${actividad.pending ? ' · Pendiente de sincronización' : ''}`));
    const detalle = actividad.details;
    if (actividad.kind === 'edit') {
      for (const cambio of detalle.changes) tarjeta.append(texto('p', `${cambio.field.trim()}: ${mostrar(cambio.before)} → ${mostrar(cambio.after)}`));
    } else if (actividad.kind === 'record_edit') {
      const etiquetas = { name: 'Nombre', position: 'Cargo', email: 'Correo', phone: 'Teléfono', notes: 'Observaciones', status: 'Estado', nextDate: 'Próximo seguimiento' };
      for (const [campo, nuevo] of Object.entries(detalle.after)) {
        if (nuevo !== detalle.before[campo]) tarjeta.append(texto('p', `${etiquetas[campo]}: ${mostrar(detalle.before[campo] ?? null)} → ${mostrar(nuevo)}`));
      }
    } else if (actividad.kind === 'record_delete') {
      tarjeta.append(texto('p', detalle.before.name || detalle.before.status));
    } else {
      tarjeta.append(texto('p', [detalle.name, detalle.position, detalle.email, detalle.phone, detalle.status, detalle.nextDate, detalle.notes].filter(Boolean).join(' · ')));
    }
    contenedor.append(tarjeta);
  }
  // Mantiene visibles los registros de la versión anterior en este mismo navegador.
  if (eventoActual.id === 'expo-paraguay-brasil-2026') {
    try {
      const indiceStand = eventoActual.columns.findIndex(c => c.includes('STAND'));
      const clave = `dataapp:${JSON.stringify(['Paraguay Business Week', empresaActual.row, empresaActual.values[0], empresaActual.values[indiceStand]])}`;
      const anteriores = JSON.parse(localStorage.getItem(clave) || '[]');
      for (const anterior of anteriores) contenedor.append(texto('article', `Registro anterior en este navegador · ${anterior.nombre || anterior.estado || anterior.tipo} · ${anterior.nota || ''}`, 'actividad'));
    } catch { contenedor.append(texto('p', 'No pudimos leer el historial de la versión anterior.')); }
  }
  if (!contenedor.childElementCount) contenedor.append(texto('p', 'Los contactos, visitas y cambios que registres aparecerán aquí.', 'ayuda'));
}

try {
  let sesion;
  try {
    sesion = await api('me');
    if (!sesion.user) await guardarCache('sesion', null).catch(() => {});
  } catch (error) {
    if (!error.sinConexion) throw error;
    sinConexion = true;
    sesion = { user: await leerCache('sesion').catch(() => null), setup: false };
    if (!sesion.user) throw new Error('Ingresá una vez con conexión para usar DataApp sin internet en este dispositivo.');
  }
  usuario = sesion.user;
  requiereConfiguracion = sesion.setup;
  if (usuario) await iniciarEspacio();
  else {
    $('#acceso').hidden = false;
    $('#rol-ingreso').hidden = requiereConfiguracion;
    $('#login-rol').disabled = requiereConfiguracion;
    if (requiereConfiguracion) {
      $('#acceso-titulo').textContent = 'Creá tu cuenta administradora';
      $('#acceso-texto').textContent = 'Es el primer ingreso. Elegí tus datos para administrar DataApp y sumar a tu equipo.';
      $('#nombre-inicial').hidden = false;
      $('#nombre-usuario').required = true;
      $('#password').minLength = 10;
      $('#password').autocomplete = 'new-password';
      $('#ingresar').textContent = 'Crear mi cuenta y comenzar →';
    }
  }
} catch (error) {
  $('#acceso').hidden = false;
  $('#error-login').textContent = error.message;
} finally { $('#cargando').hidden = true; }
