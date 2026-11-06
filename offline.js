const base = new Promise((resolver, rechazar) => {
  const solicitud = indexedDB.open('data-app-local', 1);
  solicitud.onupgradeneeded = () => {
    solicitud.result.createObjectStore('cache');
    solicitud.result.createObjectStore('pendientes', { keyPath: 'id' });
  };
  solicitud.onsuccess = () => resolver(solicitud.result);
  solicitud.onerror = () => rechazar(solicitud.error);
});
base.catch(() => {});

async function operar(almacen, modo, accion) {
  const db = await base;
  return new Promise((resolver, rechazar) => {
    const transaccion = db.transaction(almacen, modo);
    const solicitud = accion(transaccion.objectStore(almacen));
    transaccion.oncomplete = () => resolver(solicitud.result);
    transaccion.onabort = () => rechazar(transaccion.error);
  });
}

export const leerCache = clave => operar('cache', 'readonly', almacen => almacen.get(clave));
export const guardarCache = (clave, valor) => operar('cache', 'readwrite', almacen => almacen.put(valor, clave));
export const guardarPendiente = operacion => operar('pendientes', 'readwrite', almacen => almacen.put(operacion));
export const quitarPendiente = id => operar('pendientes', 'readwrite', almacen => almacen.delete(id));

export async function pendientesDe(usuarioId) {
  const pendientes = await operar('pendientes', 'readonly', almacen => almacen.getAll());
  return pendientes.filter(operacion => operacion.usuarioId === usuarioId)
    .sort((a, b) => a.orden - b.orden);
}

export function iniciarModoOffline() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}
