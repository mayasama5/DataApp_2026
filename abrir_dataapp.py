"""Servidor local de DataApp. Las cuentas y los cambios se guardan en SQLite."""
import hashlib
import io
import json
import os
import re
import secrets
import sqlite3
import time
import webbrowser
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Thread
from urllib.parse import parse_qs, urlsplit
from zipfile import BadZipFile, ZipFile

from almacenamiento import acceso_feria, administra, aplicar_catalogos, asignada, conectar, hash_password, inicializar, mismos_valores, nombre_normalizado, nueva_sesion, registrar, rubros_de_edicion, usuario_fila, usuario_sesion, verificar

CARPETA = Path(__file__).resolve().parent
PUBLICOS = {'/', '/index.html', '/app.js', '/estilos.css', '/campos.js', '/offline.js', '/dictado.js',
            '/captura-voz.js', '/sw.js', '/manifest.webmanifest', '/icono.svg',
            '/logo-dataapp-192.png', '/logo-dataapp-512.png'}
MAX_EXCEL = 12 * 1024 * 1024
PERFILES = {'consultor', 'sdr', 'marketing'}
ESTADOS_VISITA = {'REALIZADO', 'PENDIENTE'}


def estado_visita_historial(db, empresa_id, origen):
    filas = db.execute("""SELECT id,kind,details_json FROM activities
        WHERE company_id=? AND deleted_at IS NULL AND kind IN ('edit','visit') ORDER BY id DESC""", (empresa_id,))
    for fila in filas:
        detalles = json.loads(fila['details_json'])
        if fila['kind'] == 'visit' and detalles.get('status') in ESTADOS_VISITA:
            return fila['id'], detalles['status']
        if fila['kind'] == 'edit':
            for cambio in detalles['changes']:
                if cambio['field'].strip() == 'STATUS VISITA':
                    return None, cambio['after']
    return None, origen


def perfil_usuario(datos):
    perfil = datos.get('role', 'consultor')
    if perfil not in PERFILES:
        raise ErrorApp('Seleccioná un rol válido.')
    asignacion = datos.get('assignment', '').strip()
    if len(asignacion) > 150 or re.search(r'[,;/\n]', asignacion):
        raise ErrorApp('Ingresá un solo nombre tal como aparece en la planilla.')
    return perfil, asignacion if perfil != 'marketing' else ''


class ErrorApp(Exception):
    def __init__(self, mensaje, estado=400):
        self.mensaje, self.estado = mensaje, estado


class DataAppHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.webmanifest': 'application/manifest+json'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(CARPETA), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        super().end_headers()

    def token(self):
        cookies = SimpleCookie()
        try:
            cookies.load(self.headers.get('Cookie', ''))
            return cookies['dataapp'].value if 'dataapp' in cookies else ''
        except Exception:
            return ''

    def responder(self, datos, estado=200, cookie=None):
        contenido = json.dumps(datos, ensure_ascii=False).encode('utf-8')
        self.send_response(estado)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(contenido)))
        if cookie is not None:
            seguro = '; Secure' if self.server.origin.startswith('https://') else ''
            self.send_header('Set-Cookie', f'dataapp={cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age={43200 if cookie else 0}{seguro}')
        self.end_headers()
        self.wfile.write(contenido)

    def cuerpo(self):
        longitud = int(self.headers.get('Content-Length', 0))
        if longitud < 1 or longitud > 200000:
            raise ErrorApp('La solicitud no tiene un tamaño válido.')
        datos = json.loads(self.rfile.read(longitud))
        if not isinstance(datos, dict):
            raise ErrorApp('Formato de solicitud inválido.')
        return datos

    def excel_subido(self):
        longitud = int(self.headers.get('Content-Length', 0))
        if not 0 < longitud <= MAX_EXCEL:
            raise ErrorApp('Elegí un archivo Excel de hasta 12 MB.', 413)
        archivo = io.BytesIO(self.rfile.read(longitud))
        with ZipFile(archivo) as comprimido:
            if sum(entrada.file_size for entrada in comprimido.infolist()) > 100 * 1024 * 1024:
                raise ErrorApp('La planilla descomprimida supera el tamaño permitido.', 413)
        archivo.seek(0)
        return archivo

    def do_GET(self):
        ruta = urlsplit(self.path).path
        if ruta.startswith('/api/'):
            self.ejecutar_api('GET', ruta)
        elif ruta in PUBLICOS:
            super().do_GET()
        else:
            self.send_error(404)

    def do_HEAD(self):
        if urlsplit(self.path).path in PUBLICOS:
            super().do_HEAD()
        else:
            self.send_error(404)

    def do_POST(self):
        self.ejecutar_api('POST', urlsplit(self.path).path)

    def ejecutar_api(self, metodo, ruta):
        try:
            host = urlsplit(self.server.origin).netloc
            if self.headers.get('Host') != host:
                raise ErrorApp('Dirección de acceso inválida.', 403)
            if metodo == 'POST' and self.headers.get('Origin') != self.server.origin:
                raise ErrorApp('Abrí DataApp desde su dirección configurada.', 403)
            self.api(metodo, ruta)
        except ErrorApp as error:
            self.responder({'error': error.mensaje}, error.estado)
        except (ValueError, TypeError, KeyError):
            self.responder({'error': 'Revisá los datos ingresados.'}, 400)
        except sqlite3.IntegrityError:
            self.responder({'error': 'Ese correo ya está registrado.'}, 409)
        except Exception:
            self.log_error('Error interno al procesar una solicitud')
            self.responder({'error': 'No pudimos completar la operación. Intentá nuevamente.'}, 500)

    def api(self, metodo, ruta):
        usuario = usuario_sesion(self.token())
        if metodo == 'GET' and ruta == '/api/me':
            with conectar() as db:
                configurar = db.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0
            return self.responder({'user': usuario, 'setup': configurar})

        if metodo == 'POST' and ruta in {'/api/setup', '/api/login', '/api/users'}:
            datos = self.cuerpo()
            email = datos.get('email', '').strip().lower()
            password = datos.get('password', '')
            if len(email) > 200 or '@' not in email or not isinstance(password, str) or len(password) > 200:
                raise ErrorApp('Ingresá un correo y una contraseña válidos.')
            with conectar() as db:
                db.execute('BEGIN IMMEDIATE')
                if ruta == '/api/login':
                    intentos = self.server.intentos
                    ahora = time.time()
                    recientes = [t for t in intentos if t > ahora - 60]
                    self.server.intentos = recientes
                    if len(recientes) >= 10:
                        raise ErrorApp('Esperá un minuto antes de volver a intentar.', 429)
                    fila = db.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
                    if not fila or not verificar(password, fila['password']):
                        self.server.intentos.append(ahora)
                        raise ErrorApp('Correo o contraseña incorrectos.', 401)
                    cuenta = usuario_fila(fila)
                    rol_cuenta = 'marketing' if administra(cuenta) else cuenta['role']
                    if ('role' in datos and datos['role'] != rol_cuenta) or (
                        'name' in datos and nombre_normalizado(datos['name']) != nombre_normalizado(cuenta['name'])
                    ):
                        raise ErrorApp('El nombre y el rol deben coincidir con los de tu cuenta.', 401)
                else:
                    if ruta == '/api/setup' and db.execute('SELECT COUNT(*) FROM users').fetchone()[0]:
                        raise ErrorApp('La cuenta administradora ya existe.', 403)
                    if ruta == '/api/users' and not administra(usuario):
                        raise ErrorApp('Solo Marketing puede crear usuarios.', 403)
                    nombre = datos.get('name', '').strip()
                    if not nombre or len(nombre) > 150 or len(password) < 10:
                        raise ErrorApp('Ingresá un nombre y una contraseña de al menos 10 caracteres.')
                    identificador = secrets.token_hex(16)
                    rol = 'admin' if ruta == '/api/setup' else 'consultor'
                    perfil, asignacion = (None, '') if rol == 'admin' else perfil_usuario(datos)
                    db.execute('INSERT INTO users(id,name,email,password,role,profile,assignment) VALUES(?,?,?,?,?,?,?)',
                               (identificador, nombre, email, hash_password(password), rol, perfil, asignacion))
                    fila = db.execute('SELECT * FROM users WHERE id=?', (identificador,)).fetchone()
                if ruta == '/api/users':
                    registrar(db, usuario['id'], 'Cuenta creada', f'{nombre} · {perfil}')
                    token = None
                else:
                    token = nueva_sesion(db, fila['id'])
                    registrar(db, fila['id'], 'Inicio de sesión')
                respuesta = usuario_fila(fila)
            if ruta == '/api/users':
                return self.responder({'user': respuesta}, 201)
            return self.responder({'user': respuesta}, cookie=token)

        if not usuario:
            raise ErrorApp('Ingresá con tu cuenta para continuar.', 401)

        if ruta == '/api/tasks':
            from tareas import ErrorTareas, guardar_tareas, listar_tareas
            evento = parse_qs(urlsplit(self.path).query).get('event', [None])[0]
            try:
                if metodo == 'POST':
                    guardar_tareas(usuario, self.cuerpo(), evento)
                    return self.responder({'ok': True})
                return self.responder(listar_tareas(usuario, evento))
            except ErrorTareas as error:
                raise ErrorApp(str(error), error.estado)

        if metodo == 'GET' and ruta == '/api/voz':
            from voz import disponible
            return self.responder({'disponible': disponible()})

        if metodo == 'POST' and ruta == '/api/transcribir':
            from voz import MAX_AUDIO, disponible, transcribir
            if not disponible():
                raise ErrorApp('El reconocimiento local de voz todavía no está instalado.', 503)
            longitud = int(self.headers.get('Content-Length', 0))
            if not 0 < longitud <= MAX_AUDIO or longitud % 2:
                raise ErrorApp('Grabá una observación de hasta 90 segundos.')
            return self.responder({'texto': transcribir(self.rfile.read(longitud))})

        if ruta == '/api/users' and metodo == 'GET':
            if not administra(usuario):
                raise ErrorApp('Solo Marketing puede consultar las cuentas.', 403)
            with conectar() as db:
                cuentas = [usuario_fila(fila) for fila in db.execute("SELECT * FROM users WHERE role!='admin' ORDER BY name")]
            return self.responder(cuentas)

        if ruta == '/api/assignments' and metodo == 'GET':
            if not administra(usuario):
                raise ErrorApp('Solo Marketing puede gestionar las asignaciones.', 403)
            with conectar() as db:
                filas = db.execute("SELECT name,assignment,COALESCE(profile,role) AS role FROM users WHERE role!='admin'").fetchall()
            return self.responder({rol: [fila['assignment'] or fila['name'] for fila in filas if fila['role'] == rol]
                                   for rol in ('consultor', 'sdr')})

        if ruta == '/api/rubros' and metodo == 'GET':
            if not administra(usuario):
                raise ErrorApp('Solo Marketing puede consultar los rubros para editar fichas.', 403)
            evento = parse_qs(urlsplit(self.path).query).get('event', [''])[0]
            with conectar() as db:
                feria = db.execute('SELECT id,columns_json FROM events WHERE id=? AND archived_at IS NULL', (evento,)).fetchone()
                if not feria:
                    raise ErrorApp('Elegí una edición de la feria.', 404)
                return self.responder(rubros_de_edicion(db, feria))

        if metodo == 'POST' and ruta.startswith('/api/users/'):
            if not administra(usuario):
                raise ErrorApp('Solo Marketing puede cambiar roles y asignaciones.', 403)
            perfil, asignacion = perfil_usuario(self.cuerpo())
            cuenta_id = ruta.removeprefix('/api/users/')
            if cuenta_id == usuario['id'] and perfil != 'marketing':
                raise ErrorApp('Otra cuenta de Marketing puede modificar tu rol.', 403)
            with conectar() as db:
                cambio = db.execute("UPDATE users SET profile=?,assignment=? WHERE id=? AND role!='admin'",
                                    (perfil, asignacion, cuenta_id))
                if not cambio.rowcount:
                    raise ErrorApp('No encontramos esa cuenta.', 404)
                nombre_cuenta = db.execute('SELECT name FROM users WHERE id=?', (cuenta_id,)).fetchone()[0]
                registrar(db, usuario['id'], 'Permisos actualizados', f'{nombre_cuenta} · {perfil} · {asignacion}'.rstrip(' ·'))
            return self.responder({'ok': True})

        if metodo == 'POST' and ruta == '/api/events':
            if not administra(usuario):
                raise ErrorApp('Solo Marketing puede agregar ferias.', 403)
            con_excel = self.headers.get('Content-Type') == 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            datos = ({clave: valores[0] for clave, valores in parse_qs(urlsplit(self.path).query).items()}
                     if con_excel else self.cuerpo())
            nombre = datos.get('name', '').strip()
            hoja = datos.get('sheet', '').strip() or 'Empresas'
            try:
                anio = int(datos.get('year', 2026))
            except (ValueError, TypeError):
                raise ErrorApp('Elegí un año válido.')
            if not 2000 <= anio <= 2100:
                raise ErrorApp('Elegí un año entre 2000 y 2100.')
            if not nombre or len(nombre) > 120 or len(hoja) > 31 or re.search(r'[:\\/?*\[\]]', hoja):
                raise ErrorApp('Ingresá un nombre de feria y un nombre válido para la pestaña Excel.')
            if hoja.casefold() in {'data app', 'data app base', 'contactos data app', 'actividades data app', 'contactos dataapp', 'actividades dataapp'}:
                raise ErrorApp('Elegí otro nombre para la pestaña de empresas.')
            from excel import COLUMNAS_NUEVA_FERIA, REQUERIDAS
            identificador = secrets.token_hex(16)
            nombre_archivo = f'{nombre} {anio}.xlsx'
            catalogo = None
            if con_excel:
                from importar import importar
                try:
                    catalogo = importar(self.excel_subido(), identificador, nombre, hoja, nombre_archivo)
                except (BadZipFile, KeyError, StopIteration):
                    raise ErrorApp('El archivo debe ser un Excel con la pestaña de empresas indicada.')
                except ValueError as error:
                    raise ErrorApp(str(error))
                if not REQUERIDAS.issubset({campo.strip() for campo in catalogo['columnas']}):
                    raise ErrorApp('El Excel debe incluir las columnas de empresa, consultor, SDR, estado de visita y contacto.')
            with conectar() as db:
                db.execute('BEGIN IMMEDIATE')
                if any(nombre_normalizado(f['name']) == nombre_normalizado(nombre)
                       for f in db.execute('SELECT name FROM events WHERE year=?', (anio,))):
                    raise ErrorApp('Ya existe una edición de esta feria para ese año.', 409)
                if catalogo:
                    aplicar_catalogos(db, [{**catalogo, 'year': anio}])
                    registrar(db, usuario['id'], 'Excel importado', f"{len(catalogo['registros'])} registros", identificador)
                else:
                    db.execute('INSERT INTO events(id,name,source,sheet,columns_json,year) VALUES(?,?,?,?,?,?)',
                               (identificador, nombre, nombre_archivo, hoja, json.dumps(COLUMNAS_NUEVA_FERIA, ensure_ascii=False), anio))
                registrar(db, usuario['id'], 'Feria creada', evento_id=identificador)
            return self.responder({'id': identificador}, 201)

        if metodo == 'GET' and ruta == '/api/events/archived':
            if not administra(usuario):
                raise ErrorApp('Solo Marketing puede ver las ferias archivadas.', 403)
            with conectar() as db:
                archivadas = [dict(fila) for fila in db.execute('SELECT id,name,year FROM events WHERE archived_at IS NOT NULL ORDER BY name,year')]
            return self.responder(archivadas)

        if metodo == 'POST' and ruta.startswith('/api/events/'):
            if not administra(usuario):
                raise ErrorApp('Solo Marketing puede editar, eliminar o restaurar ferias.', 403)
            evento_id = ruta.removeprefix('/api/events/')
            datos = self.cuerpo()
            accion = datos.get('action')
            if accion not in {'edit', 'archive', 'restore'}:
                raise ErrorApp('La acción sobre la feria no es válida.')
            with conectar() as db:
                db.execute('BEGIN IMMEDIATE')
                feria = db.execute('SELECT name,year,archived_at FROM events WHERE id=?', (evento_id,)).fetchone()
                if not feria:
                    raise ErrorApp('No encontramos esa feria.', 404)
                if accion == 'edit':
                    nombre = datos.get('name', '').strip()
                    if not nombre or len(nombre) > 120:
                        raise ErrorApp('Ingresá un nombre de feria de hasta 120 caracteres.')
                    if feria['archived_at'] is not None:
                        raise ErrorApp('Restaurá la feria antes de editarla.', 409)
                    if any(nombre_normalizado(f['name']) == nombre_normalizado(nombre)
                           for f in db.execute('SELECT name FROM events WHERE id!=? AND year=?', (evento_id, feria['year']))):
                        raise ErrorApp('Ya existe otra feria con ese nombre.', 409)
                    if feria['name'] != nombre:
                        db.execute('UPDATE events SET name=? WHERE id=?', (nombre, evento_id))
                        registrar(db, usuario['id'], 'Feria editada', f"{feria['name']} → {nombre}", evento_id)
                else:
                    archivar = accion == 'archive'
                    if archivar == (feria['archived_at'] is None):
                        db.execute('UPDATE events SET archived_at=? WHERE id=?', (time.time() if archivar else None, evento_id))
                        registrar(db, usuario['id'], 'Feria archivada' if archivar else 'Feria restaurada', evento_id=evento_id)
            return self.responder({'ok': True})

        if metodo == 'GET' and ruta == '/api/activity':
            pagina = max(0, min(100000, int(parse_qs(urlsplit(self.path).query).get('offset', [0])[0])))
            persona = None if administra(usuario) else usuario['id']
            with conectar() as db:
                filas = db.execute('''
                    SELECT l.id AS id,l.created_at AS created_at,u.name AS author,e.name || ' · ' || e.year AS event,l.action,l.description,'' AS company,0 AS source
                    FROM activity_log l JOIN users u ON u.id=l.user_id LEFT JOIN events e ON e.id=l.event_id
                    WHERE (? IS NULL OR l.user_id=?)
                    UNION ALL
                    SELECT a.id,a.created_at,u.name,e.name || ' · ' || e.year,
                           CASE a.kind WHEN 'contact' THEN 'Contacto agregado' WHEN 'visit' THEN 'Visita registrada'
                             WHEN 'record_edit' THEN 'Registro actualizado'
                             WHEN 'record_delete' THEN CASE json_extract(a.details_json,'$.kind')
                               WHEN 'contact' THEN 'Contacto eliminado' ELSE 'Visita eliminada' END
                             ELSE 'Ficha actualizada' END,
                           CASE WHEN a.kind='contact' THEN COALESCE(json_extract(a.details_json,'$.name'),'')
                                WHEN a.kind='visit' THEN COALESCE(json_extract(a.details_json,'$.status'),'') ELSE '' END,
                           json_extract(c.values_json,'$[0]'),1
                    FROM activities a JOIN users u ON u.id=a.user_id JOIN companies c ON c.id=a.company_id
                    JOIN events e ON e.id=c.event_id WHERE (? IS NULL OR a.user_id=?)
                    ORDER BY created_at DESC,source DESC,id DESC LIMIT 101 OFFSET ?
                ''', (persona, persona, persona, persona, pagina)).fetchall()
            return self.responder({'items': [dict(fila) for fila in filas[:100]], 'more': len(filas) > 100})

        if metodo == 'POST' and ruta == '/api/logout':
            with conectar() as db:
                db.execute('DELETE FROM sessions WHERE token=?', (hashlib.sha256(self.token().encode()).hexdigest(),))
                registrar(db, usuario['id'], 'Cierre de sesión')
            return self.responder({'ok': True}, cookie='')

        if metodo == 'POST' and ruta == '/api/refresh':
            if not administra(usuario):
                raise ErrorApp('Solo Marketing puede actualizar las bases.', 403)
            from excel import configuracion, recibir, ruta_fuente
            from importar import FUENTES
            carpeta, gestionadas = configuracion()
            try:
                for fuente in FUENTES:
                    with conectar() as db:
                        activa = db.execute('SELECT 1 FROM events WHERE id=? AND archived_at IS NULL', (fuente[0],)).fetchone()
                    if activa:
                        recibir(ruta_fuente(carpeta, gestionadas, fuente), fuente[0])
                        with conectar() as db:
                            registrar(db, usuario['id'], 'Planilla actualizada', evento_id=fuente[0])
            except FileNotFoundError:
                raise ErrorApp('No encontramos ambas planillas en la carpeta de trabajo. Conservá sus nombres y volvé a intentar.')
            except ValueError as error:
                raise ErrorApp(str(error))
            with conectar() as db:
                conflictos = db.execute('SELECT COUNT(*) FROM import_conflicts').fetchone()[0]
            return self.responder({'ok': True, 'conflicts': conflictos})

        if ruta in {'/api/import', '/api/export'}:
            if not administra(usuario):
                raise ErrorApp('Solo Marketing puede importar y exportar datos.', 403)
            evento = parse_qs(urlsplit(self.path).query).get('event', [''])[0]
            if metodo == 'GET' and ruta == '/api/export':
                from excel import exportar
                contenido = exportar(evento)
                if contenido is None:
                    raise ErrorApp('No encontramos esa feria.', 404)
                with conectar() as db:
                    registrar(db, usuario['id'], 'Excel exportado', evento_id=evento)
                self.send_response(200)
                self.send_header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
                self.send_header('Content-Disposition', f'attachment; filename="{evento}.xlsx"')
                self.send_header('Content-Length', str(len(contenido)))
                self.end_headers()
                return self.wfile.write(contenido)
            if metodo == 'POST' and ruta == '/api/import':
                from excel import recibir
                try:
                    conflictos = recibir(self.excel_subido(), evento)
                except (BadZipFile, KeyError, StopIteration):
                    raise ErrorApp('El archivo debe ser un Excel con la pestaña principal de esta feria.')
                except ValueError as error:
                    raise ErrorApp(str(error))
                with conectar() as db:
                    registrar(db, usuario['id'], 'Excel importado', f'{conflictos} fichas para revisión', evento)
                return self.responder({'ok': True, 'conflicts': conflictos})

        if metodo == 'GET' and ruta == '/api/events':
            with conectar() as db:
                eventos = [dict(fila) for fila in db.execute('SELECT * FROM events WHERE archived_at IS NULL ORDER BY name,year')]
                for evento in eventos:
                    evento['accessible'] = acceso_feria(db, usuario, evento)
                    evento['columns'] = json.loads(evento.pop('columns_json'))
                    evento['count'] = (db.execute('SELECT COUNT(*) FROM companies WHERE event_id=?', (evento['id'],)).fetchone()[0]
                                       if evento['accessible'] else 0)
            return self.responder(eventos)

        if metodo == 'GET' and ruta == '/api/companies':
            evento = parse_qs(urlsplit(self.path).query).get('event', [''])[0]
            with conectar() as db:
                feria = db.execute('SELECT id,columns_json FROM events WHERE id=? AND archived_at IS NULL', (evento,)).fetchone()
                if not feria:
                    raise ErrorApp('No encontramos esa feria.', 404)
                if not acceso_feria(db, usuario, feria):
                    raise ErrorApp('Tu cuenta no tiene asignaciones en esta edición.', 403)
                columnas = json.loads(feria['columns_json'])
                empresas = [{'id': f['id'], 'row': f['source_row'], 'values': json.loads(f['values_json']),
                             'version': f['version'], 'contactsSearch': f['contacts_search'] or ''}
                            for f in db.execute('''SELECT c.*,
                                (SELECT group_concat(a.details_json,' ') FROM activities a
                                 WHERE a.company_id=c.id AND a.kind='contact' AND a.deleted_at IS NULL) AS contacts_search
                                FROM companies c WHERE event_id=? ORDER BY source_row,id''', (evento,))]
            for empresa in empresas:
                empresa['assigned'] = asignada(usuario, columnas, empresa['values'])
            return self.responder(empresas)

        if ruta.startswith('/api/company/'):
            identificador = ruta.removeprefix('/api/company/')
            with conectar() as db:
                if metodo == 'POST':
                    db.execute('BEGIN IMMEDIATE')
                empresa = db.execute('SELECT c.*,e.columns_json,e.archived_at FROM companies c JOIN events e ON e.id=c.event_id WHERE c.id=?', (identificador,)).fetchone()
                if not empresa:
                    raise ErrorApp('No encontramos esa empresa.', 404)
                columnas = json.loads(empresa['columns_json'])
                valores_actuales = json.loads(empresa['values_json'])
                indice_estado = next(i for i, columna in enumerate(columnas) if columna.strip() == 'STATUS VISITA')
                estado_origen = json.loads(empresa['source_json'])[indice_estado]
                if empresa['archived_at'] is not None:
                    raise ErrorApp('Esta feria está archivada.', 409)
                if not acceso_feria(db, usuario, {'id': empresa['event_id'], 'columns_json': empresa['columns_json']}):
                    raise ErrorApp('Tu cuenta no tiene asignaciones en esta edición.', 403)
                if metodo == 'GET':
                    if parse_qs(urlsplit(self.path).query).get('consulta') == ['1']:
                        registrar(db, usuario['id'], 'Ficha consultada', str(valores_actuales[0]), empresa['event_id'])
                    actividades = [dict(f) for f in db.execute('''SELECT a.*,u.name AS author,s.operation_id AS client_operation_id
                        FROM activities a JOIN users u ON u.id=a.user_id
                        LEFT JOIN sync_operations s ON s.record_id=a.id
                        WHERE a.company_id=? AND a.deleted_at IS NULL ORDER BY a.id DESC''', (identificador,))]
                    for actividad in actividades:
                        actividad['details'] = json.loads(actividad.pop('details_json'))
                    conflicto = db.execute('SELECT 1 FROM import_conflicts WHERE company_id=?', (identificador,)).fetchone()
                    return self.responder({'values': valores_actuales, 'version': empresa['version'], 'activities': actividades,
                                           'sourceVisitStatus': estado_origen, 'importConflict': bool(conflicto)})
                datos = self.cuerpo()
                tipo = datos.get('kind')
                operacion = datos.get('operationId')
                if operacion is not None:
                    if datos.get('userId') != usuario['id']:
                        raise ErrorApp('Ingresá con la cuenta que guardó este registro.', 403)
                    if not isinstance(operacion, str) or not re.fullmatch(r'[0-9a-f-]{36}', operacion):
                        raise ErrorApp('El identificador del registro no es válido.')
                    aplicada = db.execute('SELECT company_id FROM sync_operations WHERE user_id=? AND operation_id=?',
                                          (usuario['id'], operacion)).fetchone()
                    if aplicada:
                        if aplicada['company_id'] != identificador:
                            raise ErrorApp('El registro corresponde a otra empresa.', 409)
                        return self.responder({'ok': True})
                registro_id = datos.get('recordId')
                referencia = datos.get('recordOperationId')
                if referencia is not None:
                    fila = db.execute('''SELECT record_id FROM sync_operations
                        WHERE user_id=? AND operation_id=? AND company_id=?''', (usuario['id'], referencia, identificador)).fetchone()
                    if not fila or fila['record_id'] is None:
                        raise ErrorApp('El registro original todavía necesita sincronizarse.', 409)
                    registro_id = fila['record_id']
                if tipo == 'edit':
                    if not administra(usuario):
                        raise ErrorApp('Solo Marketing puede editar los datos compartidos de la empresa.', 403)
                    antes = json.loads(empresa['values_json'])
                    columnas = json.loads(empresa['columns_json'])
                    if 'changes' in datos:
                        cambios = datos['changes']
                        if not isinstance(cambios, list) or not cambios or len(cambios) > len(columnas):
                            raise ErrorApp('Los cambios de la ficha no son válidos.')
                        valores = antes.copy()
                        for cambio in cambios:
                            indice = cambio['index']
                            if type(indice) is not int or not 0 <= indice < len(columnas):
                                raise ErrorApp('El campo de la ficha no es válido.')
                            anterior, nuevo = cambio['before'], cambio['after']
                            if not mismos_valores(antes[indice], anterior) and not mismos_valores(antes[indice], nuevo):
                                raise ErrorApp(f'El campo {columnas[indice].strip()} cambió mientras editabas la ficha.', 409)
                            valores[indice] = nuevo
                    else:
                        valores = datos.get('values')
                        if datos.get('version') != empresa['version']:
                            raise ErrorApp('La ficha cambió mientras la editabas. Cerrala y volvé a abrirla para ver los cambios.', 409)
                    if not isinstance(valores, list) or len(valores) != len(columnas) or any(v is not None and not isinstance(v, (str, bool, int, float)) for v in valores):
                        raise ErrorApp('Los campos de la ficha no son válidos.')
                    if any(isinstance(v, str) and len(v) > 10000 for v in valores):
                        raise ErrorApp('Un campo supera el tamaño permitido.')
                    if not str(valores[0] or '').strip():
                        raise ErrorApp('El nombre de la empresa es obligatorio.')
                    consultor = next(i for i, columna in enumerate(columnas) if columna.strip() == 'CONSULTOR')
                    if valores[consultor] != antes[consultor] and len(str(valores[consultor] or '').split(',')) > 3:
                        raise ErrorApp('Podés elegir hasta tres consultores.')
                    cambios = [{'field': columnas[i], 'before': antes[i], 'after': v} for i, v in enumerate(valores) if not mismos_valores(v, antes[i])]
                    if cambios:
                        db.execute('UPDATE companies SET values_json=?,version=version+1 WHERE id=?', (json.dumps(valores, ensure_ascii=False), identificador))
                    detalle = {'changes': cambios}
                elif tipo == 'record_delete':
                    if type(registro_id) is not int:
                        raise ErrorApp('No encontramos ese registro.', 404)
                    registro = db.execute("""SELECT * FROM activities WHERE id=? AND company_id=?
                        AND kind IN ('contact','visit')""", (registro_id, identificador)).fetchone()
                    if not registro:
                        raise ErrorApp('No encontramos ese registro.', 404)
                    if registro['user_id'] != usuario['id'] and not administra(usuario):
                        raise ErrorApp('Solo podés eliminar los registros que vos agregaste.', 403)
                    if registro['deleted_at'] is not None:
                        return self.responder({'ok': True})
                    anterior = json.loads(registro['details_json'])
                    if anterior != datos.get('beforeDetails'):
                        raise ErrorApp('Ese registro cambió. Volvé a abrir la ficha antes de eliminarlo.', 409)
                    afecta_estado = False
                    if registro['kind'] == 'visit':
                        ultima, estado = estado_visita_historial(db, identificador, estado_origen)
                        afecta_estado = ultima == registro_id and estado == valores_actuales[indice_estado]
                    db.execute('UPDATE activities SET deleted_at=? WHERE id=?', (time.time(), registro_id))
                    if afecta_estado:
                        _, estado = estado_visita_historial(db, identificador, estado_origen)
                        if estado != valores_actuales[indice_estado]:
                            valores_actuales[indice_estado] = estado
                            db.execute('UPDATE companies SET values_json=?,version=version+1 WHERE id=?',
                                       (json.dumps(valores_actuales, ensure_ascii=False), identificador))
                    detalle = {'kind': registro['kind'], 'before': anterior, 'recordId': registro_id}
                elif tipo in {'contact', 'visit'}:
                    detalle = datos.get('details', {})
                    permitidos = {'name', 'position', 'email', 'phone', 'notes'} if tipo == 'contact' else {'status', 'notes', 'nextDate'}
                    if not isinstance(detalle, dict) or set(detalle) - permitidos or any(not isinstance(v, str) or len(v) > 5000 for v in detalle.values()):
                        raise ErrorApp('Revisá los datos de la actividad.')
                    if tipo == 'contact' and not detalle.get('name', '').strip():
                        raise ErrorApp('Ingresá el nombre del contacto.')
                    registro = None
                    if registro_id is not None:
                        if type(registro_id) is not int:
                            raise ErrorApp('No encontramos ese registro.', 404)
                        registro = db.execute('SELECT * FROM activities WHERE id=? AND company_id=? AND kind=?',
                                              (registro_id, identificador, tipo)).fetchone()
                        if not registro:
                            raise ErrorApp('No encontramos ese registro.', 404)
                        if registro['user_id'] != usuario['id'] and not administra(usuario):
                            raise ErrorApp('Solo podés editar los registros que vos agregaste.', 403)
                        if registro['deleted_at'] is not None:
                            raise ErrorApp('Ese registro ya fue eliminado.', 409)
                        anterior = json.loads(registro['details_json'])
                        if anterior != datos.get('beforeDetails'):
                            raise ErrorApp('Ese registro cambió mientras lo editabas.', 409)
                        detalle = {**anterior, **detalle}
                    if tipo == 'visit':
                        estado = detalle.get('status')
                        if estado not in ESTADOS_VISITA | {'SEGUIMIENTO'}:
                            raise ErrorApp('Seleccioná el estado de la visita.')
                        ultima_visita = db.execute("SELECT MAX(id) FROM activities WHERE company_id=? AND kind='visit' AND deleted_at IS NULL",
                                                  (identificador,)).fetchone()[0]
                        if estado != 'SEGUIMIENTO' and valores_actuales[indice_estado] != estado and (not registro or registro_id == ultima_visita):
                            valores_actuales[indice_estado] = estado
                            db.execute('UPDATE companies SET values_json=?,version=version+1 WHERE id=?',
                                       (json.dumps(valores_actuales, ensure_ascii=False), identificador))
                    if registro:
                        db.execute('UPDATE activities SET details_json=? WHERE id=?',
                                   (json.dumps(detalle, ensure_ascii=False), registro_id))
                        detalle = {'kind': tipo, 'before': anterior, 'after': detalle, 'recordId': registro_id}
                        tipo = 'record_edit'
                else:
                    raise ErrorApp('Actividad desconocida.')
                id_creado = None
                if tipo != 'edit' or detalle['changes']:
                    guardado = db.execute('INSERT INTO activities(company_id,user_id,kind,details_json,created_at) VALUES(?,?,?,?,?)',
                                          (identificador, usuario['id'], tipo, json.dumps(detalle, ensure_ascii=False), time.time()))
                    if tipo in {'contact', 'visit'}:
                        id_creado = guardado.lastrowid
                if operacion:
                    db.execute('INSERT INTO sync_operations(user_id,operation_id,company_id,record_id) VALUES(?,?,?,?)',
                               (usuario['id'], operacion, identificador, id_creado))
            return self.responder({'ok': True})
        raise ErrorApp('No encontramos esa opción.', 404)


def crear_servidor(puerto=8765):
    inicializar()
    servidor = ThreadingHTTPServer(('127.0.0.1', puerto), DataAppHandler)
    servidor.origin = os.environ.get('DATAAPP_ORIGIN', f'http://127.0.0.1:{servidor.server_port}').rstrip('/')
    servidor.intentos = []
    return servidor


if __name__ == '__main__':
    import sys
    try:
        servidor = crear_servidor()
    except OSError:
        print('DataApp ya está abierta o su dirección está ocupada.', flush=True)
        if '--sin-navegador' not in sys.argv:
            webbrowser.open('http://127.0.0.1:8765/')
        raise SystemExit(0)
    with servidor:
        from excel import vigilar
        detener = Event()
        Thread(target=vigilar, args=(detener,), daemon=True).start()
        print(f'DataApp disponible en {servidor.origin}/', flush=True)
        if '--sin-navegador' not in sys.argv:
            webbrowser.open('http://127.0.0.1:8765/')
        try:
            servidor.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            detener.set()
