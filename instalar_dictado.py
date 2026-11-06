"""Instala el reconocimiento local en español dentro de la carpeta de Data App."""
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.request import urlretrieve
from zipfile import ZipFile

CARPETA = Path(__file__).resolve().parent / 'datos' / 'dictado'
MODELO = 'vosk-model-small-es-0.42'


def instalar():
    CARPETA.mkdir(parents=True, exist_ok=True)
    paquetes = CARPETA / 'paquetes'
    if not (paquetes / 'vosk').is_dir():
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check',
                        '--no-cache-dir', '--index-url', 'https://pypi.org/simple',
                        '--target', str(paquetes), 'vosk==0.3.45'], check=True)
    if not (CARPETA / MODELO / 'am' / 'final.mdl').is_file():
        with tempfile.TemporaryDirectory(dir=CARPETA, prefix='modelo-') as temporal:
            carpeta = Path(temporal).resolve()
            zip_modelo = carpeta / 'modelo.zip'
            urlretrieve(f'https://alphacephei.com/vosk/models/{MODELO}.zip', zip_modelo)
            with ZipFile(zip_modelo) as archivo:
                if any(not (carpeta / entrada.filename).resolve().is_relative_to(carpeta)
                       for entrada in archivo.infolist()):
                    raise ValueError('El archivo del modelo contiene rutas inválidas.')
                archivo.extractall(carpeta)
            (carpeta / MODELO).rename(CARPETA / MODELO)
    from voz import disponible
    if not disponible():
        raise RuntimeError('No se pudo activar el reconocimiento de voz.')
    print('Dictado local en español instalado.')


if __name__ == '__main__':
    instalar()
