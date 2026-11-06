# Ficha técnica de DataApp

## Identificación

| Campo | Descripción |
| --- | --- |
| Nombre | DataApp |
| Organización | Datapar |
| Tipo | Aplicación web de gestión comercial para ferias y eventos |
| Usuarios | Consultores de ventas, SDR y Marketing |
| Estado | Piloto local validado en Windows y Microsoft Edge, con prueba de interfaz a ancho de celular |
| Acceso local | [Abrir DataApp en la computadora donde se ejecuta](http://127.0.0.1:8765/) |
| Código y guía | [Repositorio DataApp_2026](https://github.com/mayasama5/DataApp_2026) y [README](README.md) |

## Funciones

- **Ferias y eventos.** Cada edición tiene un catálogo propio. La carga inicial incluye 150 fichas de Feria San Pedro 2026 y 166 de Expo Paraguay Brasil 2026. La interfaz ofrece 2027 para crear las próximas ediciones.
- **Ficha de empresa.** Búsqueda por empresa, contacto, teléfono, consultor o stand. La ficha muestra el rubro, condición de cliente, adherencia, productos, asignaciones y estado de visita. Incluye formularios separados para datos de empresa, contactos y visitas o seguimientos, con historial por autor y fecha.
- **Mi cartera y Mis pendientes.** La cartera se arma con las asignaciones de la edición. Las visitas realizadas salen de pendientes. El checklist personal permite agregar tareas, poner fecha y hora y marcar avances.
- **Observaciones por voz.** Dictado en español con un motor local instalado en el equipo que ejecuta DataApp. El navegador debe permitir el acceso al micrófono.
- **Excel.** Marketing puede crear una edición con una planilla, importar cambios o exportar su catálogo con hojas de contactos y actividades. DataApp vigila las copias de trabajo configuradas y marca conflictos si Excel y la aplicación cambian un campo a valores diferentes.

## Roles y separación de datos

| Rol | Acceso y permisos |
| --- | --- |
| Consultor de ventas | Consulta ediciones donde tiene asignaciones, ve su cartera y sus pendientes, y gestiona sus propios contactos y visitas. |
| SDR | Tiene el mismo alcance de consulta y edición de registros propios, con cartera basada en la columna SDR. |
| Marketing | Administra usuarios y ediciones, edita datos compartidos, gestiona registros del equipo e importa o exporta Excel. |

Cada edición tiene un identificador propio. Dos fichas de la misma empresa en ferias o años distintos guardan contactos, visitas e historial por separado. Las tareas se vinculan a la edición y a la cuenta que las creó. Los archivos exportados conservan un identificador que permite rechazar su carga en otra edición. Para planillas originales, Marketing confirma la feria y el año de destino al importar.

## Tecnología y operación

| Componente | Implementación |
| --- | --- |
| Interfaz | HTML, CSS y JavaScript. Diseño adaptable y acceso desde la pantalla de inicio con HTTPS. |
| Servidor | Python con API HTTP. La instalación local escucha en el puerto 8765 de la computadora. |
| Persistencia | SQLite para cuentas, fichas, tareas e historial. IndexedDB y caché del navegador para el trabajo sin conexión. |
| Acceso | Correo, contraseña y rol. Contraseñas derivadas con PBKDF2 y sesiones mediante cookies HttpOnly. |
| Archivos | Excel `.xlsx` mediante openpyxl. Planillas y base de trabajo se guardan aparte del código. |
| Sin conexión | Cada persona entra y abre la edición con conexión primero. El mismo navegador guarda los cambios pendientes y los envía al recuperar conexión con esa cuenta. |

## Puesta en marcha compartida

1. TI habilita un servidor con almacenamiento persistente, respaldo y una dirección HTTPS.
2. Se restaura o importa la base autorizada y Marketing prepara las cuentas del equipo.
3. Se prueba con usuarios y celulares reales. La prueba debe cubrir acceso, permisos, micrófono, una carga en modo avión y la sincronización al volver a conectarse.

La publicación en GitHub actualiza el código fuente. La versión compartida queda disponible cuando TI despliega ese código en el servidor y habilita su dirección.
