"""Persistencia local, autenticación e historial de DataApp."""
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
import unicodedata
from contextlib import contextmanager
from pathlib import Path

BASE = Path(os.environ.get('DATAAPP_DB', Path(__file__).with_name('dataapp.sqlite3')))
ADHERENTE = 'ADHERENTE?'
RUBROS_COMUNES = (
    'Agro / agronegocios', 'Agro e Industria Alimentaria', 'Automotores / maquinarias', 'Banco',
    'Comercio', 'Comercio / Agro', 'Comercio Exterior y Logística', 'Construcción e Inmobiliario',
    'Consultoría y Servicios', 'Cooperativa', 'Distribuidora / Insumos', 'Fábrica', 'Financiero y Bancario',
    'Industria y Manufactura', 'Instituciones y Organismos', 'Otros sectores', 'Prensa',
    'Stand sin asignación', 'Tecnología', 'Tecnología y Software',
)


def completar_adherente(evento):
    if ADHERENTE in {columna.strip().upper() for columna in evento['columnas']}:
        return
    evento['columnas'].append(ADHERENTE)
    for registro in evento['registros']:
        registro['valores'].append(None)
        if 'base' in registro:
            registro['base'].append(None)


@contextmanager
def conectar():
    conexion = sqlite3.connect(BASE, timeout=15)
    conexion.row_factory = sqlite3.Row
    conexion.execute('PRAGMA foreign_keys = ON')
    try:
        with conexion:
            yield conexion
    finally:
        conexion.close()


def inicializar():
    with conectar() as db:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','consultor')));
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
                sheet TEXT NOT NULL, columns_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS companies (
                id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id),
                source_row INTEGER NOT NULL, source_json TEXT NOT NULL,
                values_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS activities (
                id INTEGER PRIMARY KEY AUTOINCREMENT, company_id TEXT NOT NULL REFERENCES companies(id),
                user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
                details_json TEXT NOT NULL, created_at REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS company_event ON companies(event_id);
            CREATE INDEX IF NOT EXISTS activity_company ON activities(company_id, id);
            CREATE TABLE IF NOT EXISTS import_conflicts (
                company_id TEXT PRIMARY KEY REFERENCES companies(id), incoming_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sync_operations (
                user_id TEXT NOT NULL REFERENCES users(id), operation_id TEXT NOT NULL,
                company_id TEXT NOT NULL REFERENCES companies(id), PRIMARY KEY(user_id,operation_id));
            CREATE TABLE IF NOT EXISTS activity_log (
                id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                action TEXT NOT NULL, event_id TEXT REFERENCES events(id),
                description TEXT NOT NULL, created_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS tasks (
                user_id TEXT NOT NULL REFERENCES users(id), id TEXT NOT NULL, title TEXT NOT NULL,
                date TEXT NOT NULL, time TEXT NOT NULL, done INTEGER NOT NULL CHECK(done IN (0,1)),
                version INTEGER NOT NULL, completed_at REAL, PRIMARY KEY(user_id,id));
            CREATE TABLE IF NOT EXISTS task_operations (
                user_id TEXT NOT NULL REFERENCES users(id), operation_id TEXT NOT NULL,
                PRIMARY KEY(user_id,operation_id));
        ''')
        campos_usuario = {fila['name'] for fila in db.execute('PRAGMA table_info(users)')}
        if 'profile' not in campos_usuario:
            db.execute('ALTER TABLE users ADD COLUMN profile TEXT')
        if 'assignment' not in campos_usuario:
            db.execute("ALTER TABLE users ADD COLUMN assignment TEXT NOT NULL DEFAULT ''")
        if 'archived_at' not in {fila['name'] for fila in db.execute('PRAGMA table_info(events)')}:
            db.execute('ALTER TABLE events ADD COLUMN archived_at REAL')
        if 'year' not in {fila['name'] for fila in db.execute('PRAGMA table_info(events)')}:
            db.execute('ALTER TABLE events ADD COLUMN year INTEGER NOT NULL DEFAULT 2026')
        if 'event_id' not in {fila['name'] for fila in db.execute('PRAGMA table_info(tasks)')}:
            db.execute('ALTER TABLE tasks ADD COLUMN event_id TEXT REFERENCES events(id)')
        for feria in db.execute('SELECT id,columns_json FROM events').fetchall():
            columnas = json.loads(feria['columns_json'])
            if ADHERENTE in {columna.strip().upper() for columna in columnas}:
                continue
            columnas.append(ADHERENTE)
            db.execute('UPDATE events SET columns_json=? WHERE id=?', (json.dumps(columnas, ensure_ascii=False), feria['id']))
            db.execute("""UPDATE companies SET values_json=json_insert(values_json,'$[#]',NULL),
                source_json=json_insert(source_json,'$[#]',NULL),version=version+1 WHERE event_id=?""", (feria['id'],))
            db.execute("""UPDATE import_conflicts SET incoming_json=json_insert(incoming_json,'$[#]',NULL)
                WHERE company_id IN (SELECT id FROM companies WHERE event_id=?)""", (feria['id'],))
        if 'deleted_at' not in {fila['name'] for fila in db.execute('PRAGMA table_info(activities)')}:
            db.execute('ALTER TABLE activities ADD COLUMN deleted_at REAL')
        if 'record_id' not in {fila['name'] for fila in db.execute('PRAGMA table_info(sync_operations)')}:
            db.execute('ALTER TABLE sync_operations ADD COLUMN record_id INTEGER REFERENCES activities(id)')
        db.execute('CREATE INDEX IF NOT EXISTS sync_record ON sync_operations(record_id)')
        ruta = Path(__file__).with_name('catalogos.json')
        if ruta.is_file():
            existentes = {fila[0] for fila in db.execute('SELECT id FROM events')}
            nuevos = [evento for evento in json.loads(ruta.read_text(encoding='utf-8')) if evento['id'] not in existentes]
            aplicar_catalogos(db, nuevos)


def mismos_valores(a, b):
    return type(a) is type(b) and a == b


def aplicar_catalogos(db, eventos):
    for evento in eventos:
        completar_adherente(evento)
        anterior = db.execute('SELECT columns_json,archived_at FROM events WHERE id=?', (evento['id'],)).fetchone()
        if anterior and anterior['archived_at'] is not None:
            continue
        columnas = json.dumps(evento['columnas'], ensure_ascii=False)
        if anterior and [campo.strip() for campo in json.loads(anterior['columns_json'])] != [campo.strip() for campo in evento['columnas']]:
            raise ValueError('Cambió el orden o el nombre de las columnas. La importación requiere revisión.')
        db.execute('INSERT INTO events(id,name,source,sheet,columns_json,year) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
                   (evento['id'], evento['evento'], evento['archivo'], evento['pestana'], columnas, evento.get('year', 2026)))
        for registro in evento['registros']:
            entrantes = json.loads(json.dumps(registro['valores'], ensure_ascii=False, default=str))
            serializados = json.dumps(entrantes, ensure_ascii=False)
            empresa = db.execute('SELECT * FROM companies WHERE id=?', (registro['id'],)).fetchone()
            if empresa is None:
                db.execute('INSERT INTO companies(id,event_id,source_row,source_json,values_json) VALUES(?,?,?,?,?)',
                           (registro['id'], evento['id'], registro['fila'], serializados, serializados))
                continue
            if empresa['event_id'] != evento['id']:
                raise ValueError('La planilla contiene identificadores de otra feria.')
            base = json.loads(empresa['source_json'])
            base_comparacion = registro.get('base', base)
            actuales = json.loads(empresa['values_json'])
            conflicto = False
            hubo_cambios = False
            for indice, nuevo in enumerate(entrantes):
                if mismos_valores(base_comparacion[indice], nuevo):
                    continue
                if mismos_valores(actuales[indice], base_comparacion[indice]):
                    actuales[indice] = nuevo
                    hubo_cambios = True
                elif not mismos_valores(actuales[indice], nuevo):
                    conflicto = True
                    continue
                base[indice] = nuevo
            db.execute('UPDATE companies SET source_json=?,values_json=?,source_row=?,version=version+? WHERE id=?',
                       (json.dumps(base, ensure_ascii=False), json.dumps(actuales, ensure_ascii=False),
                        registro['fila'], int(hubo_cambios), registro['id']))
            if conflicto:
                db.execute('INSERT INTO import_conflicts VALUES(?,?) ON CONFLICT(company_id) DO UPDATE SET incoming_json=excluded.incoming_json',
                           (registro['id'], serializados))
            else:
                db.execute('DELETE FROM import_conflicts WHERE company_id=?', (registro['id'],))


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 600000).hex()
    return salt + ':' + digest


def verificar(password, esperado):
    return hmac.compare_digest(hash_password(password, esperado.split(':')[0]), esperado)


def usuario_fila(fila):
    return {'id': fila['id'], 'name': fila['name'], 'email': fila['email'],
            'role': fila['profile'] or fila['role'], 'assignment': fila['assignment']}


def nombre_normalizado(valor):
    sin_acentos = ''.join(c for c in unicodedata.normalize('NFD', str(valor or '')) if not unicodedata.combining(c))
    return ' '.join(sin_acentos.casefold().split())


def rubros_de_edicion(db, feria):
    rubros = {nombre_normalizado(rubro): rubro for rubro in RUBROS_COMUNES}
    columnas = json.loads(feria['columns_json'])
    indice = next((i for i, columna in enumerate(columnas) if nombre_normalizado(columna) == 'rubro'), None)
    if indice is not None:
        filas = db.execute('SELECT source_json FROM companies WHERE event_id=? ORDER BY source_row, id', (feria['id'],))
        for fila in filas:
            rubro = json.loads(fila['source_json'])[indice]
            if isinstance(rubro, str) and rubro.strip():
                etiqueta = ' '.join(rubro.split())
                rubros.setdefault(nombre_normalizado(etiqueta), etiqueta)
    return [rubros[clave] for clave in sorted(rubros)]


def administra(usuario):
    return bool(usuario and usuario['role'] in {'admin', 'marketing'})


def asignada(usuario, columnas, valores):
    if administra(usuario):
        return True
    columna = 'SDR' if usuario['role'] == 'sdr' else 'CONSULTOR'
    indice = next((i for i, campo in enumerate(columnas) if campo.strip().upper() == columna), None)
    asignacion = nombre_normalizado(usuario['assignment'] or usuario['name'])
    return indice is not None and asignacion in {
        nombre_normalizado(nombre) for nombre in re.split(r'[,;/\n]', str(valores[indice] or '')) if nombre.strip()
    }


def acceso_feria(db, usuario, feria):
    if administra(usuario):
        return True
    columnas = json.loads(feria['columns_json'])
    return any(asignada(usuario, columnas, json.loads(fila[0]))
               for fila in db.execute('SELECT values_json FROM companies WHERE event_id=?', (feria['id'],)))


def registrar(db, usuario_id, accion, descripcion='', evento_id=None):
    db.execute('INSERT INTO activity_log(user_id,action,event_id,description,created_at) VALUES(?,?,?,?,?)',
               (usuario_id, accion, evento_id, descripcion, time.time()))


def usuario_sesion(token):
    with conectar() as db:
        fila = db.execute('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>?',
                          (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
        return usuario_fila(fila) if fila else None


def nueva_sesion(db, user_id):
    token = secrets.token_urlsafe(32)
    db.execute('DELETE FROM sessions WHERE expires<?', (time.time(),))
    db.execute('INSERT INTO sessions VALUES(?,?,?)',
               (hashlib.sha256(token.encode()).hexdigest(), user_id, time.time() + 43200))
    return token
