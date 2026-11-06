# DataApp

CRM de Datapar para organizar empresas, contactos, visitas y tareas por feria y año. La versión actual se puede probar en una computadora con Windows. Para el uso compartido desde celulares y computadoras, el equipo de TI debe habilitar un servidor y una dirección HTTPS.

[Ficha técnica de DataApp](FICHA_TECNICA.md)

## Cómo abrir

Abrí la carpeta de la aplicación en el Explorador de archivos de Windows y hacé doble clic en **Abrir DataApp.cmd**. Se abrirá el navegador. Mantené la ventana de DataApp abierta mientras trabajás. La dirección es `http://127.0.0.1:8765/`.

En el primer ingreso, creá la cuenta administradora inicial con tu nombre, correo y una contraseña de al menos 10 caracteres. En los siguientes ingresos usá el nombre, correo, contraseña y rol registrados para tu cuenta. La cuenta inicial ingresa como **Marketing**.

## Preparar una copia nueva

Con Python instalado, abrí una terminal en la carpeta del proyecto e instalá las dependencias.

```powershell
python -m pip install -r requirements.txt
```

Para cargar los dos catálogos iniciales, colocá las planillas autorizadas en una carpeta local y ejecutá `python importar.py --carpeta "C:\ruta\a\las\planillas"`. El script espera los nombres de archivo indicados en **Planillas**. También podés iniciar con una base vacía, crear una feria desde Marketing e importar su planilla desde la app.

En Windows, abrí **Abrir DataApp.cmd** o ejecutá `python abrir_dataapp.py`. Para habilitar el dictado local en español, ejecutá `python instalar_dictado.py`.

## Cómo usar

1. En **Ferias y eventos**, elegí una feria y después el año. Los datos iniciales corresponden a **Feria San Pedro 2026** y **Expo Paraguay Brasil 2026**. La opción **2027** permite crear una edición con su propia base.
2. Escribí el nombre de la empresa, contacto, consultor, teléfono o stand en el buscador.
3. Pulsá **Abrir ficha** para ver los datos comerciales, los contactos y las visitas guardadas. La sección **Historial de cambios** indica quién registró o modificó los datos.
4. Pulsá **Editar o agregar registro**. En **Datos de empresa** podés cambiar los campos comerciales. En **Contacto** y **Visita o seguimiento** podés agregar un registro o elegir uno existente para actualizarlo. Después de guardar, la ficha vuelve a mostrar el resumen actualizado.
5. En **Observaciones**, pulsá **Dictar observación**, permití el acceso al micrófono y hablá. Después pulsá **Detener y transcribir** y revisá el texto antes de guardar. Con el motor local instalado, el equipo que ejecuta DataApp transcribe el audio en español. En una instalación nueva, se puede habilitar con `python instalar_dictado.py`. Si el navegador integrado bloquea el micrófono, abrí la misma dirección en Edge o Chrome.

En la cabecera de cada edición aparece su nombre y año, con accesos a **Empresas**, **Mi cartera** y **Mis pendientes**. El catálogo y la búsqueda se limitan a esa edición. Una empresa que aparece en dos ediciones tiene una ficha independiente en cada una, con sus propios contactos, visitas e historial.

**Mi cartera** usa la columna Consultor para **Consultor de ventas** y la columna SDR para **SDR**. Una cuenta puede consultar el catálogo de una edición si tiene alguna asignación allí. **Mis pendientes** muestra las empresas de la cartera con visita en estado **Pendiente**. Marketing puede consultar todas las ediciones.

En **Mis pendientes**, **Mi checklist** guarda tareas personales de la edición seleccionada, con fecha y hora previstas. Podés crear una tarea, cargar una plantilla, editarla y marcarla como completada. Las tareas son independientes del estado de visita de las empresas. Los cambios guardados sin conexión se sincronizan al volver a conectarte. Las tareas creadas antes de separar los años aparecen aparte y podés incorporarlas a una edición.

Consultores y SDR pueden guardar, editar y eliminar sus propios contactos, visitas y seguimientos. Los botones **Editar** y **Eliminar** aparecen al lado del registro en la ficha. También funcionan para los registros nuevos que están pendientes de sincronización. Marketing puede editar los datos compartidos de la empresa y gestionar los registros de cualquier integrante. Las eliminaciones quedan en el historial. Desde **Usuarios del equipo**, Marketing crea las cuentas y define su rol. Cuando el nombre de la cuenta difiere del nombre de la planilla, cargá el segundo en **Nombre en la planilla**.

Marketing puede crear, renombrar, importar, exportar y eliminar ferias del listado. **Eliminar feria** la archiva. Se puede restaurar desde **Ferias archivadas** con los mismos datos. **Registro de actividad** muestra los ingresos, cambios comerciales y acciones de administración. Marketing ve la actividad del equipo y cada consultor o SDR ve la de su propia cuenta.

Para agregar un evento, pulsá **Agregar feria** e ingresá el nombre, el año y el nombre de la pestaña de empresas. Podés adjuntar un Excel al guardar o importarlo desde esa edición más adelante. Si la feria ya existe, elegí **Crear edición** en el año disponible. Al exportar una edición vacía se descarga una plantilla para completarla y volverla a importar.

## Planillas

| Edición en DataApp | Archivo en Descargas | Pestaña | Registros iniciales |
| --- | --- | --- | --- |
| Feria San Pedro 2026 | Estrategia de Trabajo Feria San Pedro 2026.xlsx | San Pedro 2026 | 150 |
| Expo Paraguay Brasil 2026 | Estrategia de Trabajo Business Week 2026.xlsx | Business Week | 166 |

Cada catálogo conserva sus columnas originales. **Adherente** aparece junto a **Cliente** y permite elegir **Sin indicar**, **Sí**, **No** o **Parcería**. **Rubro** muestra 20 categorías comunes como opciones. Los rubros nuevos que se importan en una edición se suman únicamente a su lista. La app importa la pestaña de empresas indicada al crear cada edición.

Mientras DataApp está iniciada, revisa cada 10 segundos las copias de trabajo de la carpeta **planillas**. En una instalación sin copias configuradas, revisa los dos archivos originales en **Descargas**. Las vistas abiertas de **Ferias y eventos**, **Mi cartera** y **Mis pendientes** consultan los datos cada 10 segundos con conexión. Al guardar una reasignación en la planilla conectada, la empresa cambia de cartera en la siguiente actualización. Si la visita pasa a **Realizado**, sale de la lista de visitas pendientes. La cuenta administradora también puede pulsar **Actualizar desde las planillas** o **Importar Excel** dentro de una feria y seleccionar su archivo. La lectura usa los valores calculados que Excel haya guardado.

**Exportar Excel** descarga solo la edición seleccionada, con su catálogo y sus hojas de contactos y actividades. Cada Excel exportado queda vinculado a la edición que lo generó y DataApp rechaza su carga en otra. Al subir una planilla original, confirmá el archivo, la feria y el año en el aviso de importación. La aplicación usa la edición seleccionada para las planillas originales que carecen de un identificador interno.

Las nuevas filas se incorporan a esa edición y se conservan las filas repetidas. Si Excel y DataApp cambian el mismo campo a valores distintos, se conserva el dato de DataApp y se marca la ficha para revisión. En una planilla original, cambiar el nombre de la empresa o el stand puede generar una ficha nueva. Las copias exportadas mantienen el vínculo de cada empresa cuando esos valores cambian.

Para el intercambio en ambas direcciones, usá `san-pedro-2026.xlsx` y `expo-paraguay-brasil-2026.xlsx` dentro de la carpeta **planillas**, junto a la aplicación. Son copias de trabajo con el catálogo y el historial de DataApp. En otro equipo, podés cambiar su ubicación con `DATAAPP_EXCEL_DIR` y habilitar la escritura con `DATAAPP_ESCRIBIR_EXCEL=1`. El servidor usa esas copias y envía allí las fichas, los contactos y las visitas sincronizadas. Si Excel bloquea el archivo mientras está abierto, el servidor reintenta al quedar disponible. Las hojas internas de las copias conservan el vínculo y la versión de los campos. Las hojas **Contactos DataApp** y **Actividades DataApp** son salidas del historial de la aplicación.

## Dónde quedan los datos

Las cuentas, fichas, tareas e historial se guardan en **dataapp.sqlite3**, en esta carpeta. Para respaldar una instalación local, cerrá DataApp y copiá la carpeta a una ubicación segura de la empresa. El repositorio contiene el código y la documentación. La base SQLite, las planillas de trabajo y los datos de uso se guardan aparte.

Ingresá con conexión en el dispositivo antes de salir a la feria. Abrí el catálogo que vas a usar. En modo avión podés abrir las fichas de ese catálogo y guardar cambios, contactos y visitas. La barra muestra cuántos registros esperan conexión. Al recuperar conexión, volvé a abrir DataApp para que envíe la cola con la misma cuenta. Mantené el navegador y sus datos hasta ver que ya no quedan pendientes. Si dos personas cambian el mismo campo, el registro del dispositivo se conserva y se avisa que requiere revisión.

## Después de revisar el prototipo

1. **Preparar el acceso compartido.** El equipo de TI debe instalar Python y las dependencias de `requirements.txt`, configurar una carpeta persistente para la base `DATAAPP_DB` y restaurar una copia de la base local o generar `catalogos.json` con `python importar.py --carpeta <carpeta de planillas>`. El servidor se inicia con `python abrir_dataapp.py --sin-navegador`. Debe permanecer activo y recibir tráfico de un servidor web que ofrezca HTTPS. Configurá `DATAAPP_ORIGIN` con la dirección HTTPS exacta y conservá la cabecera Host al reenviar solicitudes a `127.0.0.1:8765`. Creá una cuenta por consultor y configurá copias de respaldo. GitHub guarda el código y el servidor proporciona la dirección de la app.
2. **Abrir en los celulares.** Cada consultor entra una vez con internet desde la dirección HTTPS del equipo. En Android, usá el menú de Chrome para instalar la app o crear su acceso directo. En iPhone, en Safari elegí **Compartir**, **Añadir a pantalla de inicio** y **Abrir como app web**. [Android](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid) · [iPhone](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios)
3. **Primera prueba de campo.** Probá una ficha en cada feria. Seleccioná productos, asigná tres consultores, elegí una fecha y registrá un contacto y una visita. Repetí la carga en modo avión, cerrá y reabrí la app, recuperá conexión y verificá que el registro aparezca en otro equipo y en la copia Excel configurada. Usá un conjunto de datos de prueba antes de habilitar el uso general.

## Verificación técnica

Se usa Python con SQLite para que la instalación local disponga de autenticación y guardado permanente sin contratar servicios. Las contraseñas se almacenan derivadas con PBKDF2, y las sesiones usan cookies HttpOnly. El acceso se limita a la computadora local.

Pruebas de integración con una base temporal:

```powershell
python -m unittest test_dataapp -v
```

La prueba de interfaz usa Edge mediante Playwright del runtime de Codex. Ejecutá `prueba_interfaz.cjs` con la variable `DATAAPP_RUNTIME` apuntando al directorio `dependencies` de ese runtime. Ambas pruebas usan bases temporales y no crean usuarios de prueba en la instalación real.

La prueba de aislamiento carga la misma empresa en dos años, registra un contacto y una tarea exclusivos y verifica que se mantengan en su edición. También intenta importar un Excel exportado en otra edición y comprueba que el servidor lo rechaza. La prueba de interfaz recorre ambas ferias, verifica los controles con ancho de celular y prueba la cola de cambios sin conexión.

El esquema actual está en `almacenamiento.py`. El estado del piloto y los requisitos para ponerlo a disposición del equipo figuran en la [ficha técnica](FICHA_TECNICA.md).
