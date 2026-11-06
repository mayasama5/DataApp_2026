export const camposContacto = ['NOMBRE CONTACTO', 'CARGO', 'CORREO', 'TELEFONO'];

const opcionesMultiples = {
  'PRODUCTO ACTUAL': ['Datapar ERP', 'Clover CRM', 'Datapar MRP', 'Datapar Agro', 'Datapar Cloud', 'Datapar BI', 'Datapar Facturae'],
  CONSULTOR: ['Sandra', 'Sofía', 'Helio', 'Maga', 'Caio', 'Christian', 'Mauricio'],
  'ACCION POST VISITA': ['Cerrado ganado', 'Propuesta comercial', 'Reunión post feria', 'Follow up', 'Sin contacto clave', 'Sin interés', 'No adherente'],
  'ACCION MARKETING': ['Contenido stand cliente', 'Contenido stand Datapar', 'Entrega de regalos'],
};

const opcionesUnicas = {
  SDR: [['María Paz', 'María Paz'], ['Vanessa', 'Vanessa']],
  'STATUS VISITA': [['PENDIENTE', 'Pendiente'], ['REALIZADO', 'Realizado']],
};

export function claveCampo(valor) {
  return String(valor ?? '').normalize('NFD').replace(/\p{M}/gu, '').trim().toUpperCase();
}

function claveOpcion(valor) {
  return claveCampo(valor).replace(/[^A-Z0-9]/g, '');
}

function crear(etiqueta, contenido) {
  const nodo = document.createElement(etiqueta);
  nodo.textContent = contenido;
  return nodo;
}

function multiple(campo, titulo, opciones, valor) {
  const limite = campo === 'CONSULTOR' ? 3 : opciones.length;
  const grupo = crear('fieldset', '');
  grupo.className = 'campo ancho opciones-campo';
  grupo.append(crear('legend', titulo));
  const ayuda = crear('p', campo === 'CONSULTOR' ? 'Podés elegir hasta 3 consultores.' : 'Podés elegir más de una opción.');
  ayuda.className = 'ayuda';
  grupo.append(ayuda);
  const origen = String(valor ?? '').split(/[,;/\n]/).map(item => item.trim()).filter(Boolean);
  const desconocidos = origen.filter(item => !opciones.some(opcion => claveOpcion(opcion) === claveOpcion(item)));
  if (desconocidos.length) {
    const anterior = crear('p', `Valor anterior: ${desconocidos.join(', ')}`);
    anterior.className = 'ayuda';
    grupo.append(anterior);
  }
  const lista = crear('div', '');
  lista.className = 'opciones-lista';
  const entradas = opciones.map(opcion => {
    const etiqueta = crear('label', '');
    const casilla = document.createElement('input');
    casilla.type = 'checkbox';
    casilla.value = opcion;
    casilla.checked = origen.some(item => claveOpcion(item) === claveOpcion(opcion));
    etiqueta.append(casilla, document.createTextNode(opcion));
    lista.append(etiqueta);
    return casilla;
  });
  const elegidas = () => entradas.filter(entrada => entrada.checked).map(entrada => entrada.value);
  const inicial = elegidas().join(', ');
  function limitar() {
    const completo = elegidas().length >= limite;
    entradas.forEach(entrada => { entrada.disabled = completo && !entrada.checked; });
  }
  grupo.addEventListener('change', limitar);
  limitar();
  grupo.append(lista);
  return { nodo: grupo, leer: () => {
    const seleccion = elegidas().join(', ');
    return seleccion === inicial ? valor : seleccion || null;
  } };
}

export function crearCampo(columna, indice, valor, asignaciones = {}) {
  const campo = claveCampo(columna);
  const titulo = campo === 'ADHERENTE?' ? 'Adherente / parcería' : columna.trim();
  if (Object.hasOwn(opcionesMultiples, campo)) {
    const opciones = [...opcionesMultiples[campo]];
    if (campo === 'CONSULTOR') {
      for (const nombre of [...(asignaciones.consultor || []), ...String(valor ?? '').split(/[,;/\n]/)]) {
        if (nombre.trim() && !opciones.some(opcion => claveOpcion(opcion) === claveOpcion(nombre))) opciones.push(nombre.trim());
      }
    }
    return multiple(campo, titulo, opciones, valor);
  }
  const contenedor = crear('div', '');
  const ancho = /OBSERVACIONES|CRUCE|CRITERIO/.test(campo);
  contenedor.className = ancho ? 'campo ancho' : 'campo';
  const etiqueta = crear('label', titulo);
  etiqueta.htmlFor = `campo-${indice}`;
  const booleano = /^(CLIENTE\?|POTENCIAL |ADHERENTE\?)/.test(campo) || typeof valor === 'boolean';
  let opciones = booleano ? [['true', 'Sí'], ['false', 'No']] : opcionesUnicas[campo];
  if (campo === 'SDR') {
    opciones = [...opcionesUnicas.SDR];
    for (const nombre of asignaciones.sdr || []) {
      if (!opciones.some(([clave]) => claveOpcion(clave) === claveOpcion(nombre))) opciones.push([nombre, nombre]);
    }
  }
  let entrada;
  let leer;
  if (opciones) {
    entrada = document.createElement('select');
    const original = valor === null || valor === '' ? '' : opciones.find(([clave]) => claveOpcion(clave) === claveOpcion(valor))?.[0] ?? 'anterior';
    const alternativas = booleano || original === '' ? [['', 'Sin indicar'], ...opciones] : [...opciones];
    if (original === 'anterior') alternativas.push(['anterior', `${valor} (valor anterior)`]);
    for (const [clave, nombre] of alternativas) {
      const opcion = crear('option', nombre);
      opcion.value = clave;
      if (!booleano && clave === '') opcion.disabled = true;
      entrada.append(opcion);
    }
    entrada.value = original;
    leer = () => entrada.value === original ? valor : entrada.value === '' ? null : booleano ? entrada.value === 'true' : entrada.value;
  } else {
    entrada = document.createElement(ancho ? 'textarea' : 'input');
    if (campo === 'FECHA') {
      entrada.type = 'date';
      entrada.value = /^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(String(valor)) ? String(valor).slice(0, 10) : '';
      entrada.addEventListener('click', () => {
        if (entrada.showPicker) entrada.showPicker();
      });
      entrada.addEventListener('keydown', evento => {
        if (/^[0-9]$/.test(evento.key)) evento.preventDefault();
      });
      if (valor && !entrada.value) {
        const anterior = crear('p', `Fecha anterior: ${valor}`);
        anterior.className = 'ayuda';
        contenedor.append(anterior);
      }
    } else {
      entrada.value = valor ?? '';
      entrada.maxLength = 10000;
      if (indice === 0) entrada.required = true;
    }
    const inicial = entrada.value;
    leer = () => entrada.value === inicial ? valor : entrada.value || null;
  }
  entrada.id = `campo-${indice}`;
  contenedor.append(etiqueta, entrada);
  return { nodo: contenedor, leer };
}
