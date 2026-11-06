const FRECUENCIA = 16000;
const SEGUNDOS = 90;
let sesionActiva;

export function detenerDictado() {
  sesionActiva?.cancelar();
}

async function grabarLocal(sesion, actualizar, insertar) {
  const Contexto = window.AudioContext || window.webkitAudioContext;
  if (!navigator.mediaDevices?.getUserMedia || !Contexto || !window.AudioWorkletNode) {
    throw new Error('Este navegador no habilita el micrófono aquí. Abrí la misma dirección en Edge o Chrome.');
  }
  const contexto = new Contexto({ sampleRate: FRECUENCIA });
  let microfono;
  let nodo;
  let temporizador;
  sesion.limpiar = () => {
    clearTimeout(temporizador);
    microfono?.getTracks().forEach(pista => pista.stop());
    nodo?.disconnect();
    if (contexto.state !== 'closed') contexto.close().catch(() => {});
  };
  try {
    await contexto.resume();
    microfono = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  } catch (error) {
    const mensaje = {
      NotAllowedError: 'Permití el micrófono para DataApp. Si el navegador integrado lo bloquea, abrí la misma dirección en Edge o Chrome.',
      NotFoundError: 'Conectá o activá un micrófono para dictar.',
      NotReadableError: 'No se pudo abrir el micrófono. Revisá que esté disponible.',
    }[error.name];
    throw new Error(mensaje || 'No pudimos abrir el micrófono.');
  }
  if (sesion.signal.aborted) {
    sesion.limpiar();
    return;
  }
  if (contexto.sampleRate !== FRECUENCIA || !contexto.audioWorklet) {
    throw new Error('El navegador no admite este modo de grabación. Probá desde Edge o Chrome.');
  }
  await contexto.audioWorklet.addModule('/captura-voz.js');
  if (sesion.signal.aborted) return;
  const entrada = contexto.createMediaStreamSource(microfono);
  nodo = new AudioWorkletNode(contexto, 'captura-voz');
  const partes = [];
  let muestras = 0;
  let vaciado;
  nodo.port.onmessage = ({ data }) => {
    if (data === null) {
      vaciado?.();
      return;
    }
    const bloque = data.subarray(0, SEGUNDOS * FRECUENCIA - muestras);
    if (!bloque.length) return;
    partes.push(bloque);
    muestras += bloque.length;
  };
  entrada.connect(nodo);
  nodo.connect(contexto.destination);
  sesion.finalizar = async () => {
    sesion.finalizar = null;
    actualizar('Transcribiendo…', 'Cancelar');
    try {
      await new Promise(resolve => {
        const espera = setTimeout(resolve, 350);
        vaciado = () => { clearTimeout(espera); resolve(); };
        nodo.port.postMessage('vaciar');
      });
      sesion.limpiar();
      if (sesion.signal.aborted) return;
      if (!muestras) {
        sesion.terminar('No llegó audio del micrófono. Volvé a intentar.');
        return;
      }
      const respuesta = await fetch('/api/transcribir', {
        method: 'POST', body: new Blob(partes, { type: 'application/octet-stream' }),
        signal: sesion.signal,
      });
      const datos = await respuesta.json();
      if (!respuesta.ok) throw new Error(datos.error);
      if (sesion.signal.aborted) return;
      if (datos.texto) insertar(datos.texto);
      sesion.terminar(datos.texto ? 'Revisá el texto antes de guardar.' : 'No se reconoció voz. Acercate al micrófono y volvé a intentar.');
    } catch (error) {
      if (!sesion.signal.aborted) sesion.terminar(error.message || 'No pudimos transcribir el audio.');
    }
  };
  temporizador = setTimeout(sesion.finalizar, SEGUNDOS * 1000);
  actualizar('Grabando. Hablá y pulsá Detener y transcribir al terminar.', 'Detener y transcribir');
}

function dictarEnNavegador(sesion, actualizar, insertar) {
  const Reconocimiento = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Reconocimiento) {
    sesion.terminar('El motor de voz no está disponible aquí. Podés dictar con el micrófono del teclado.');
    return;
  }
  const reconocimiento = new Reconocimiento();
  reconocimiento.lang = 'es-MX';
  reconocimiento.continuous = true;
  let mensaje = 'Revisá el texto antes de guardar.';
  reconocimiento.onresult = evento => {
    if (sesion.signal.aborted) return;
    for (let i = evento.resultIndex; i < evento.results.length; i++) {
      if (evento.results[i].isFinal) insertar(evento.results[i][0].transcript);
    }
  };
  reconocimiento.onerror = evento => {
    mensaje = evento.error === 'not-allowed' || evento.error === 'service-not-allowed'
      ? 'Permití el micrófono o abrí DataApp en Edge o Chrome.'
      : 'El reconocimiento del navegador no respondió. Podés usar el micrófono del teclado.';
  };
  reconocimiento.onend = () => { if (!sesion.signal.aborted) sesion.terminar(mensaje); };
  sesion.limpiar = () => { if (sesion.signal.aborted) reconocimiento.abort(); };
  sesion.finalizar = () => reconocimiento.stop();
  reconocimiento.start();
  actualizar('Escuchando…', 'Detener dictado');
}

export function controlDictado(campo) {
  const grupo = document.createElement('div');
  grupo.className = 'dictado';
  const boton = document.createElement('button');
  boton.type = 'button';
  boton.className = 'secundario';
  boton.textContent = 'Dictar observación';
  const estado = document.createElement('span');
  estado.className = 'ayuda';
  estado.setAttribute('role', 'status');
  grupo.append(boton, estado);

  function actualizar(mensaje, etiqueta) {
    estado.textContent = mensaje;
    boton.textContent = etiqueta;
  }

  function insertar(frase) {
    const nuevo = [campo.value.trimEnd(), frase.trim()].filter(Boolean).join(' ');
    campo.value = campo.maxLength >= 0 ? nuevo.slice(0, campo.maxLength) : nuevo;
  }

  boton.addEventListener('click', async () => {
    if (sesionActiva?.boton === boton) {
      if (sesionActiva.finalizar) sesionActiva.finalizar();
      else sesionActiva.cancelar();
      return;
    }
    detenerDictado();
    const controlador = new AbortController();
    const sesion = {
      boton,
      signal: controlador.signal,
      terminar(mensaje) {
        if (sesionActiva !== sesion) return;
        sesionActiva = null;
        sesion.limpiar?.();
        actualizar(mensaje, 'Dictar observación');
      },
      cancelar() {
        controlador.abort();
        sesion.terminar('Dictado cancelado.');
      },
    };
    sesionActiva = sesion;
    actualizar('Preparando el micrófono…', 'Cancelar');
    try {
      const local = await fetch('/api/voz', { signal: sesion.signal }).then(respuesta => respuesta.json()).catch(() => ({}));
      if (sesion.signal.aborted) return;
      if (local.disponible) await grabarLocal(sesion, actualizar, insertar);
      else dictarEnNavegador(sesion, actualizar, insertar);
    } catch (error) {
      if (!sesion.signal.aborted) sesion.terminar(error.message || 'No pudimos iniciar el dictado.');
    }
  });
  return grupo;
}
