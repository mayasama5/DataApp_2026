"""Lee catálogos autorizados sin modificar los archivos de Excel."""
import argparse
import hashlib
import json
import re
import tempfile
from collections import Counter
from pathlib import Path
from openpyxl import load_workbook
from almacenamiento import ADHERENTE, completar_adherente

FUENTES = [
    ('san-pedro-2026', 'Feria San Pedro', 'San Pedro 2026', 'Estrategia de Trabajo Feria San Pedro 2026.xlsx'),
    ('expo-paraguay-brasil-2026', 'Expo Paraguay Brasil', 'Business Week', 'Estrategia de Trabajo Business Week 2026.xlsx'),
]


def importar(ruta, evento_id, nombre, pestana, archivo=None):
    libro = load_workbook(ruta, read_only=True, data_only=True)
    try:
        filas = enumerate(libro[pestana].values, start=1)
        _, encabezados = next(filas)
        columnas = list(encabezados)
        while columnas and columnas[-1] is None:
            columnas.pop()
        ids = bool(columnas and columnas[-1] == '__DATAAPP_ID')
        tiene_origen = 'Data App' in libro
        if (tiene_origen and libro['Data App']['A1'].value != evento_id) or (ids and not tiene_origen):
            raise ValueError('La planilla exportada pertenece a otra feria o edición.')
        if ids:
            columnas.pop()
        bases = {}
        if ids and 'Data App Base' in libro:
            for fila_base in libro['Data App Base'].values:
                if fila_base[0] and len(fila_base) == len(columnas) + 1:
                    bases[fila_base[0]] = [json.loads(valor) for valor in fila_base[1:]]
        if not columnas or columnas[0] != 'EMPRESA' or any(not isinstance(c, str) or not c.strip() for c in columnas):
            raise ValueError(f'Encabezados inválidos en {pestana}')
        stand = next(i for i, c in enumerate(columnas) if 'STAND' in c.upper())
        registros = []
        identificadores = set()
        repeticiones = Counter()
        for numero, fila in filas:
            if not any(v not in (None, '') for v in fila):
                continue
            if any(v not in (None, '') for v in fila[len(columnas) + int(ids):]):
                raise ValueError(f'Fila {numero} tiene datos sin encabezado')
            valores = list(fila[:len(columnas)])
            valores.extend([None] * (len(columnas) - len(valores)))
            identidad = json.dumps([evento_id, valores[0], valores[stand]], ensure_ascii=False, default=str)
            repeticiones[identidad] += 1
            clave = f'{identidad}|{repeticiones[identidad]}'
            identificador = fila[len(columnas)] if ids and len(fila) > len(columnas) else None
            if identificador and not re.fullmatch(r'[0-9a-f]{32}', str(identificador)):
                raise ValueError(f'El identificador interno de la fila {numero} no es válido.')
            identificador = identificador or hashlib.sha256(clave.encode()).hexdigest()[:32]
            if identificador in identificadores:
                raise ValueError(f'La fila {numero} repite un identificador. Si duplicaste una fila, borrá su identificador interno.')
            identificadores.add(identificador)
            registro = {'id': identificador, 'fila': numero, 'valores': valores}
            if identificador in bases:
                registro['base'] = bases[identificador]
            registros.append(registro)
        catalogo = {'id': evento_id, 'evento': nombre, 'archivo': archivo or ruta.name,
                    'pestana': pestana, 'columnas': columnas, 'registros': registros,
                    'faltaba_adherente': ADHERENTE not in {columna.strip().upper() for columna in columnas}}
        completar_adherente(catalogo)
        return catalogo
    finally:
        libro.close()


def actualizar_catalogos(carpeta=None):
    carpeta = carpeta or Path.home() / 'Downloads'
    eventos = [importar(carpeta / archivo, clave, nombre, pestana) for clave, nombre, pestana, archivo in FUENTES]
    destino = Path(__file__).with_name('catalogos.json')
    if destino.exists():
        anteriores = {e['id']: e for e in json.loads(destino.read_text(encoding='utf-8'))}
        for evento in eventos:
            previo = anteriores.get(evento['id'])
            if previo:
                completar_adherente(previo)
            if previo and previo['columnas'] != evento['columnas']:
                raise ValueError('Cambió el orden o el nombre de las columnas. La actualización requiere revisión.')
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=destino.parent,
                                     prefix='catalogos-', suffix='.tmp', delete=False) as archivo:
        temporal = Path(archivo.name)
        json.dump(eventos, archivo, ensure_ascii=False, default=str)
    try:
        temporal.replace(destino)
    finally:
        temporal.unlink(missing_ok=True)
    return eventos


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--carpeta', type=Path, default=Path.home() / 'Downloads')
    args = parser.parse_args()
    eventos = actualizar_catalogos(args.carpeta)
    for evento in eventos:
        print(f"{evento['evento']}: {len(evento['registros'])} registros, {len(evento['columnas'])} columnas")
