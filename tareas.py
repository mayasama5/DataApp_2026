"""Checklist personal y sincronización de sus cambios."""
import re
from datetime import date, time
from time import time as ahora

from almacenamiento import acceso_feria, conectar, registrar


class ErrorTareas(Exception):
    def __init__(self, mensaje, estado=400):
        super().__init__(mensaje)
        self.estado = estado


def verificar_feria(db, usuario, evento):
    if evento is None:
        return
    feria = db.execute('SELECT id,columns_json FROM events WHERE id=? AND archived_at IS NULL', (evento,)).fetchone()
    if not feria:
        raise ErrorTareas('No encontramos esa edición de la feria.', 404)
    if not acceso_feria(db, usuario, feria):
        raise ErrorTareas('Tu cuenta no tiene asignaciones en esta edición.', 403)


def listar_tareas(usuario, evento=None):
    with conectar() as db:
        verificar_feria(db, usuario, evento)
        filas = db.execute('SELECT id,title,date,time,done,version,completed_at FROM tasks WHERE user_id=? AND event_id IS ?',
                           (usuario['id'], evento))
        return [dict(fila, done=bool(fila['done'])) for fila in filas]


def guardar_tareas(usuario, datos, evento=None):
    usuario_id = usuario['id']
    operacion = datos.get('operationId')
    cambios = datos.get('changes')
    if datos.get('userId') != usuario_id:
        raise ErrorTareas('Ingresá con la cuenta que guardó estas tareas.', 403)
    if not isinstance(operacion, str) or not re.fullmatch(r'[0-9a-f-]{36}', operacion):
        raise ErrorTareas('La operación no es válida.')
    if not isinstance(cambios, list) or not 1 <= len(cambios) <= 10:
        raise ErrorTareas('Agregá entre una y diez tareas.')
    with conectar() as db:
        db.execute('BEGIN IMMEDIATE')
        verificar_feria(db, usuario, evento)
        if db.execute('SELECT 1 FROM task_operations WHERE user_id=? AND operation_id=?', (usuario_id, operacion)).fetchone():
            return
        for cambio in cambios:
            if not isinstance(cambio, dict):
                raise ErrorTareas('Revisá los datos de la tarea.')
            tarea_id = cambio.get('id')
            titulo, fecha, hora = (cambio.get(campo, '') for campo in ('title', 'date', 'time'))
            hecha, version = cambio.get('done'), cambio.get('version')
            if (not isinstance(tarea_id, str) or not re.fullmatch(r'[0-9a-f-]{36}', tarea_id)
                    or not all(isinstance(valor, str) for valor in (titulo, fecha, hora))
                    or not 1 <= len(titulo.strip()) <= 200 or type(hecha) is not bool
                    or type(version) is not int or version < 0):
                raise ErrorTareas('Revisá el nombre, la fecha y la hora de la tarea.')
            try:
                if fecha and date.fromisoformat(fecha).isoformat() != fecha:
                    raise ValueError()
                if hora and (not fecha or time.fromisoformat(hora).isoformat(timespec='minutes') != hora):
                    raise ValueError()
            except ValueError:
                raise ErrorTareas('Elegí una fecha válida y, si corresponde, su hora.')
            anterior = db.execute('SELECT * FROM tasks WHERE user_id=? AND id=?', (usuario_id, tarea_id)).fetchone()
            mover = anterior and anterior['event_id'] is None and evento is not None and cambio.get('moverAnterior') is True
            if anterior and anterior['event_id'] != evento and not mover:
                raise ErrorTareas('La tarea pertenece a otra edición.', 409)
            if (anterior['version'] if anterior else 0) != version:
                raise ErrorTareas('Esta tarea cambió en otro dispositivo.', 409)
            completada = (anterior['completed_at'] if anterior and anterior['done'] else ahora()) if hecha else None
            db.execute('''INSERT INTO tasks(user_id,id,title,date,time,done,version,completed_at,event_id)
                VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET title=excluded.title,date=excluded.date,
                time=excluded.time,done=excluded.done,version=excluded.version,completed_at=excluded.completed_at,
                event_id=excluded.event_id''',
                       (usuario_id, tarea_id, titulo.strip(), fecha, hora, hecha, version + 1, completada, evento))
            if not anterior:
                accion = 'Tarea creada'
            elif mover:
                accion = 'Tarea asignada a la edición'
            elif bool(anterior['done']) != hecha:
                accion = 'Tarea completada' if hecha else 'Tarea reabierta'
            else:
                accion = 'Tarea editada'
            registrar(db, usuario_id, accion, titulo.strip(), evento)
        db.execute('INSERT INTO task_operations VALUES(?,?)', (usuario_id, operacion))
