"""Importación, exportación y sincronización de copias de trabajo de Excel."""
import io
import json
import os
import sqlite3
import tempfile
from pathlib import Path
from threading import Event
from datetime import datetime, timezone
from zipfile import BadZipFile

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

from almacenamiento import aplicar_catalogos, conectar, mismos_valores
from importar import FUENTES, importar

COLUMNAS_NUEVA_FERIA = [
    'EMPRESA', 'RUBRO', 'CLIENTE?', 'PRODUCTO ACTUAL', 'POTENCIAL ERP', 'POTENCIAL CLOVER',
    'POTENCIAL MRP', 'POTENCIAL AGRO', 'POTENCIAL CLOUD', 'POTENCIAL BI', 'CONSULTOR', 'SDR',
    'STATUS VISITA', 'ACCIÓN POST VISITA', 'FECHA', 'ACCIÓN MARKETING', 'NOMBRE CONTACTO',
    'CARGO', 'CORREO', 'TELEFONO', 'LOTE / STAND', 'SECTOR', 'OBSERVACIONES',
    'RESULTADO CRUCE CRM', 'NOMBRE COINCIDENTE EN CUENTAS.CSV', 'ESTADO EN CRM', 'CRITERIO DE CRUCE',
]


def configuracion():
    configurada = os.environ.get('DATAAPP_EXCEL_DIR')
    if configurada:
        return Path(configurada), os.environ.get('DATAAPP_ESCRIBIR_EXCEL') == '1'
    locales = Path(__file__).with_name('planillas')
    if all((locales / f'{clave}.xlsx').is_file() for clave, _, _, _ in FUENTES):
        return locales, True
    return Path.home() / 'Downloads', False


def ruta_fuente(carpeta, gestionadas, fuente):
    clave, _, _, nombre_archivo = fuente
    copia = carpeta / f'{clave}.xlsx'
    return copia if gestionadas and copia.is_file() else carpeta / nombre_archivo


def datos_feria(db, evento_id):
    evento = db.execute('SELECT * FROM events WHERE id=?', (evento_id,)).fetchone()
    empresas = db.execute('SELECT * FROM companies WHERE event_id=? ORDER BY source_row,id', (evento_id,)).fetchall()
    actividades = db.execute('''SELECT a.*,u.name AS author,c.values_json
        FROM activities a JOIN users u ON u.id=a.user_id JOIN companies c ON c.id=a.company_id
        WHERE c.event_id=? ORDER BY a.id''', (evento_id,)).fetchall()
    return evento, empresas, actividades


def poner(celda, valor):
    celda.value = valor
    if isinstance(valor, str):
        celda.data_type = 's'


def anexar(hoja, valores):
    hoja.append([None] * len(valores))
    fila = hoja.max_row
    for indice, valor in enumerate(valores, 1):
        poner(hoja.cell(fila, indice), valor)


def formato(hoja):
    hoja.freeze_panes = 'B2'
    hoja.auto_filter.ref = hoja.dimensions
    for celda in hoja[1]:
        celda.fill = PatternFill('solid', fgColor='064C3C')
        celda.font = Font(color='FFFFFF', bold=True)
        hoja.column_dimensions[celda.column_letter].width = min(38, max(16, len(str(celda.value)) + 3))


def guardar_bases(libro, bases):
    if 'Data App Base' in libro:
        del libro['Data App Base']
    hoja = libro.create_sheet('Data App Base')
    hoja.sheet_state = 'hidden'
    for identificador, valores in bases.items():
        anexar(hoja, [identificador, *(json.dumps(None if v == '' else v, ensure_ascii=False, default=str) for v in valores)])


def hojas_actividad(libro, actividades):
    for nombre, encabezados in [
        ('Contactos Data App', ['Empresa', 'Nombre', 'Cargo', 'Correo', 'Teléfono', 'Registrado por']),
        ('Actividades Data App', ['Empresa', 'Tipo', 'Estado', 'Próximo seguimiento', 'Observaciones', 'Registrado por', 'Fecha']),
    ]:
        if nombre in libro:
            del libro[nombre]
        anexar(libro.create_sheet(nombre), encabezados)
    for fila in actividades:
        if fila['deleted_at'] is not None:
            continue
        datos = json.loads(fila['details_json'])
        empresa = json.loads(fila['values_json'])[0]
        if fila['kind'] == 'contact':
            anexar(libro['Contactos Data App'], [empresa, *(datos.get(k) for k in ('name', 'position', 'email', 'phone')), fila['author']])
        elif fila['kind'] == 'visit':
            fecha = datetime.fromtimestamp(fila['created_at'], timezone.utc).isoformat(timespec='seconds')
            anexar(libro['Actividades Data App'], [empresa, 'Visita o seguimiento', *(datos.get(k) for k in ('status', 'nextDate', 'notes')), fila['author'], fecha])
    formato(libro['Contactos Data App'])
    formato(libro['Actividades Data App'])


def exportar(evento_id):
    with conectar() as db:
        evento, empresas, actividades = datos_feria(db, evento_id)
    if not evento or evento['archived_at'] is not None:
        return None
    libro = Workbook()
    hoja = libro.active
    hoja.title = evento['sheet']
    columnas = json.loads(evento['columns_json'])
    anexar(hoja, [*columnas, '__DATAAPP_ID'])
    bases = {}
    for empresa in empresas:
        valores = json.loads(empresa['values_json'])
        anexar(hoja, [*valores, empresa['id']])
        bases[empresa['id']] = valores
    formato(hoja)
    hoja.column_dimensions[get_column_letter(len(columnas) + 1)].hidden = True
    metadatos = libro.create_sheet('Data App')
    metadatos.append([evento_id, actividades[-1]['id'] if actividades else 0])
    metadatos.sheet_state = 'hidden'
    guardar_bases(libro, bases)
    hojas_actividad(libro, actividades)
    archivo = io.BytesIO()
    libro.save(archivo)
    return archivo.getvalue()


def recibir(archivo, evento_id):
    with conectar() as db:
        evento = db.execute('SELECT * FROM events WHERE id=?', (evento_id,)).fetchone()
    if not evento or evento['archived_at'] is not None:
        raise ValueError('Elegí una feria válida.')
    catalogo = importar(archivo, evento_id, evento['name'], evento['sheet'], evento['source'])
    with conectar() as db:
        db.execute('BEGIN IMMEDIATE')
        if db.execute('SELECT archived_at FROM events WHERE id=?', (evento_id,)).fetchone()[0] is not None:
            raise ValueError('Restaurá la feria antes de importar datos.')
        inicial = evento_id not in {fuente[0] for fuente in FUENTES} and not db.execute(
            'SELECT 1 FROM companies WHERE event_id=? LIMIT 1', (evento_id,)
        ).fetchone()
        if inicial and catalogo['registros']:
            requeridas = {'EMPRESA', 'CONSULTOR', 'SDR', 'STATUS VISITA', 'NOMBRE CONTACTO', 'CARGO', 'CORREO', 'TELEFONO'}
            if not requeridas.issubset({campo.strip() for campo in catalogo['columnas']}):
                raise ValueError('La planilla debe incluir las columnas de empresa, consultor, SDR, estado de visita y contacto. Podés descargar la plantilla de esta feria.')
            db.execute('UPDATE events SET columns_json=? WHERE id=?',
                       (json.dumps(catalogo['columnas'], ensure_ascii=False), evento_id))
        aplicar_catalogos(db, [catalogo])
        return db.execute('''SELECT COUNT(*) FROM import_conflicts i JOIN companies c ON c.id=i.company_id
            WHERE c.event_id=?''', (evento_id,)).fetchone()[0]


def firma(ruta):
    estado = ruta.stat()
    return estado.st_mtime_ns, estado.st_size


def actualizar_copia(ruta, fuente, esperada):
    evento_id, nombre, pestana, _ = fuente
    catalogo = importar(ruta, evento_id, nombre, pestana)
    libro = load_workbook(io.BytesIO(ruta.read_bytes()))
    temporal = None
    try:
        if 'Data App' not in libro or libro['Data App']['A1'].value != evento_id:
            return
        with conectar() as db:
            db.execute('BEGIN IMMEDIATE')
            feria = db.execute('SELECT archived_at FROM events WHERE id=?', (evento_id,)).fetchone()
            if not feria or feria['archived_at'] is not None:
                return
            aplicar_catalogos(db, [catalogo])
            _, empresas, actividades = datos_feria(db, evento_id)
            por_id = {empresa['id']: empresa for empresa in empresas}
            hoja = libro[pestana]
            max_actividad = actividades[-1]['id'] if actividades else 0
            cambio = libro['Data App']['B1'].value != max_actividad
            bases = {}
            for registro in catalogo['registros']:
                empresa = por_id[registro['id']]
                base = registro.get('base', json.loads(empresa['source_json']))
                actual = json.loads(empresa['values_json'])
                fila = registro['fila']
                if not hoja.cell(fila, len(actual) + 1).value:
                    poner(hoja.cell(fila, len(actual) + 1), registro['id'])
                    cambio = True
                siguiente_base = base.copy()
                for indice, valor in enumerate(actual):
                    celda = hoja.cell(fila, indice + 1)
                    previo = registro['valores'][indice]
                    if previo is not None and not isinstance(previo, (str, int, float, bool)):
                        previo = str(previo)
                    if celda.data_type != 'f' and mismos_valores(previo, base[indice]) and not mismos_valores(previo, valor):
                        poner(celda, valor)
                        cambio = True
                        siguiente_base[indice] = valor
                    elif mismos_valores(previo, valor) and not mismos_valores(base[indice], previo):
                        siguiente_base[indice] = previo
                        cambio = True
                bases[registro['id']] = siguiente_base
            if not cambio:
                return
            hojas_actividad(libro, actividades)
            guardar_bases(libro, bases)
            libro['Data App']['B1'] = max_actividad
            with tempfile.NamedTemporaryFile(dir=ruta.parent, suffix='.xlsx', prefix='.dataapp-', delete=False) as salida:
                temporal = Path(salida.name)
            libro.save(temporal)
            if firma(ruta) == esperada:
                temporal.replace(ruta)
    finally:
        libro.close()
        if temporal:
            temporal.unlink(missing_ok=True)


def vigilar(detener: Event):
    carpeta, gestionadas = configuracion()
    vistas = {}
    while not detener.wait(10):
        with conectar() as db:
            adicionales = [tuple(fila) for fila in db.execute('SELECT id,name,sheet,source FROM events WHERE archived_at IS NULL')]
        activas = {fuente[0] for fuente in adicionales}
        fuentes = [fuente for fuente in FUENTES if fuente[0] in activas]
        if gestionadas:
            iniciales = {fuente[0] for fuente in FUENTES}
            fuentes.extend(fuente for fuente in adicionales
                           if fuente[0] not in iniciales and (carpeta / f'{fuente[0]}.xlsx').is_file())
        for fuente in fuentes:
            clave = fuente[0]
            ruta = ruta_fuente(carpeta, gestionadas, fuente)
            try:
                actual = firma(ruta)
                if gestionadas and ruta.name == f'{clave}.xlsx':
                    with conectar() as db:
                        ultimo = db.execute('''SELECT COALESCE(MAX(a.id),0) FROM activities a
                            JOIN companies c ON c.id=a.company_id WHERE c.event_id=?''', (clave,)).fetchone()[0]
                    estado = (actual, ultimo)
                    if vistas.get(ruta) != estado:
                        actualizar_copia(ruta, fuente, actual)
                        vistas[ruta] = estado
                elif vistas.get(ruta) != actual:
                    recibir(ruta, clave)
                    vistas[ruta] = actual
            except FileNotFoundError:
                vistas.pop(ruta, None)
            except (OSError, ValueError, KeyError, BadZipFile, StopIteration, sqlite3.OperationalError):
                # Excel puede bloquear el archivo mientras guarda. Se vuelve a intentar.
                continue
