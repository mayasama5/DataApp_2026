"""Convierte audio PCM mono de 16 kHz a texto, sin enviar el audio a terceros."""
import importlib.util
import json
import os
import sys
from pathlib import Path
from threading import BoundedSemaphore, Lock

CARPETA = Path(__file__).resolve().parent / 'datos' / 'dictado'
RUTA_MODELO = Path(os.environ.get('DATAAPP_VOZ_MODELO', CARPETA / 'vosk-model-small-es-0.42'))
PAQUETES = CARPETA / 'paquetes'
FRECUENCIA = 16000
MAX_AUDIO = 90 * FRECUENCIA * 2
_carga = Lock()
_turnos = BoundedSemaphore(2)
_modelo = None


def disponible():
    if not (RUTA_MODELO / 'am' / 'final.mdl').is_file():
        return False
    if PAQUETES.is_dir() and str(PAQUETES) not in sys.path:
        sys.path.append(str(PAQUETES))
    return importlib.util.find_spec('vosk') is not None


def transcribir(audio):
    global _modelo
    from vosk import KaldiRecognizer, Model, SetLogLevel
    with _carga:
        if _modelo is None:
            SetLogLevel(-1)
            _modelo = Model(str(RUTA_MODELO))
    with _turnos:
        recognizer = KaldiRecognizer(_modelo, FRECUENCIA)
        partes = []
        for inicio in range(0, len(audio), 8000):
            if recognizer.AcceptWaveform(audio[inicio:inicio + 8000]):
                partes.append(json.loads(recognizer.Result()).get('text', ''))
        partes.append(json.loads(recognizer.FinalResult()).get('text', ''))
    return ' '.join(parte for parte in partes if parte).strip()
