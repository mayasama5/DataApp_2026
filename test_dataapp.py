"""Pruebas de integración sobre una base temporal, sin modificar los datos reales."""
import http.cookiejar
import io
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import almacenamiento
from abrir_dataapp import crear_servidor


class FlujoCRM(unittest.TestCase):
    def setUp(self):
        self.temporal = tempfile.TemporaryDirectory(dir=Path(__file__).parent, prefix='.qa-')
        self.original = almacenamiento.BASE
        almacenamiento.BASE = Path(self.temporal.name) / 'prueba.sqlite3'
        self.server = crear_servidor(0)
        self.hilo = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.hilo.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.cliente = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.hilo.join()
        almacenamiento.BASE = self.original
        self.temporal.cleanup()

    def api(self, ruta, datos=None, cliente=None, origen=True):
        headers = {'Content-Type': 'application/json'}
        if origen:
            headers['Origin'] = self.url
        peticion = urllib.request.Request(self.url + '/api/' + ruta,
                                        data=None if datos is None else json.dumps(datos).encode(), headers=headers)
        try:
            with (cliente or self.cliente).open(peticion) as respuesta:
                return respuesta.status, json.load(respuesta)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def test_crm_aislamiento_autoria_y_conflictos(self):
        self.assertEqual(self.api('events')[0], 401)
        cuenta = {'name': 'Administradora de prueba', 'email': 'admin@prueba.test', 'password': 'Clave-prueba-2026'}
        self.assertEqual(self.api('setup', cuenta, origen=False)[0], 403)
        self.assertEqual(self.api('setup', cuenta)[0], 200)
        self.assertEqual(self.api('setup', cuenta)[0], 403)
        eventos = self.api('events')[1]
        self.assertEqual({e['name']: e['count'] for e in eventos}, {'Feria San Pedro': 150, 'Expo Paraguay Brasil': 166})
        san = next(e for e in eventos if e['name'] == 'Feria San Pedro')
        empresas = self.api('companies?event=' + san['id'])[1]
        oro = next(e for e in empresas if e['values'][0] == 'Oro Verde')
        ruta = 'company/' + oro['id']
        original = self.api(ruta)[1]
        self.assertEqual(len(original['values']), 27)
        valores = original['values'].copy()
        indice = san['columns'].index('OBSERVACIONES')
        valores[indice] = 'Observación de prueba'
        edicion = {'kind': 'edit', 'version': original['version'], 'values': valores}
        self.assertEqual(self.api(ruta, edicion)[0], 200)
        self.assertEqual(self.api(ruta, edicion)[0], 409)
        consultor = {'name': 'Consultor de prueba', 'email': 'consultor@prueba.test', 'password': 'Consultor-2026',
                     'role': 'consultor', 'assignment': 'Sandra'}
        self.assertEqual(self.api('users', consultor)[0], 201)
        self.api('logout', {})
        self.assertEqual(self.api(ruta)[0], 401)
        self.assertEqual(self.api('login', {**consultor, 'password': 'incorrecta'})[0], 401)
        self.assertEqual(self.api('login', {**consultor, 'role': 'marketing'})[0], 401)
        self.assertEqual(self.api('login', consultor)[0], 200)
        self.assertEqual(self.api('users', cuenta)[0], 403)
        self.assertEqual(self.api(ruta, {'kind': 'contact', 'details': {'name': 'Contacto Oro Verde', 'phone': '0981'}})[0], 200)
        self.assertEqual(self.api(ruta, {'kind': 'visit', 'details': {'status': 'REALIZADO', 'notes': 'Conversación comercial'}})[0], 200)
        detalle = self.api(ruta)[1]
        self.assertEqual(detalle['values'][indice], 'Observación de prueba')
        self.assertEqual(detalle['values'][san['columns'].index('STATUS VISITA')], 'REALIZADO')
        self.assertEqual([a['author'] for a in detalle['activities']], ['Consultor de prueba', 'Consultor de prueba', 'Administradora de prueba'])
        almacenamiento.inicializar()
        self.assertEqual(self.api(ruta)[1], detalle)
        self.assertEqual(sum(e['count'] for e in self.api('events')[1]), 316)
        listado = self.api('companies?event=' + san['id'])[1]
        self.assertEqual(len(listado), 150)
        asignadas = {e['id'] for e in listado if e['assigned']}
        self.assertIn(oro['id'], asignadas)
        self.assertTrue(0 < len(asignadas) < 150)
        ajena = next(e for e in empresas if e['id'] not in asignadas)
        self.assertEqual(self.api('company/' + ajena['id'])[0], 200)
        self.assertEqual(self.api('export?event=' + san['id'])[0], 403)
        self.assertFalse(any(e['id'] == oro['id'] for e in self.api('companies?event=expo-paraguay-brasil-2026')[1]))
        usuario = self.api('me')[1]['user']
        operacion = {'kind': 'visit', 'details': {'status': 'SEGUIMIENTO'}, 'userId': usuario['id'], 'operationId': str(uuid.uuid4())}
        self.assertEqual(self.api(ruta, operacion)[0], 200)
        self.assertEqual(self.api(ruta, operacion)[0], 200)
        despues = self.api(ruta)[1]
        self.assertEqual(len(despues['activities']), len(detalle['activities']) + 1)
        self.assertEqual(despues['values'][san['columns'].index('STATUS VISITA')], 'REALIZADO')
        self.assertEqual(self.api(ruta, {'kind': 'edit', 'changes': [
            {'index': indice, 'before': 'Valor obsoleto', 'after': 'Otro valor'},
        ]})[0], 403)
        self.api('logout', {})
        self.assertEqual(self.api('login', {**cuenta, 'role': 'marketing'})[0], 200)

        from excel import actualizar_copia, exportar, firma
        from importar import FUENTES
        from openpyxl import load_workbook
        copia = Path(self.temporal.name) / 'san-pedro-2026.xlsx'
        copia.write_bytes(exportar(san['id']))
        libro = load_workbook(copia)
        hoja = libro[san['sheet']]
        fila_oro = next(i for i, fila in enumerate(hoja.values, 1) if fila[0] == 'Oro Verde')
        hoja.cell(fila_oro, san['columns'].index('RUBRO') + 1, 'Rubro desde Excel')
        libro.save(copia)
        libro.close()
        self.assertEqual(self.api(ruta, {'kind': 'edit', 'changes': [
            {'index': indice, 'before': despues['values'][indice], 'after': 'Actualizado desde Data App'},
        ]})[0], 200)
        actualizar_copia(copia, FUENTES[0], firma(copia))
        libro = load_workbook(io.BytesIO(copia.read_bytes()), read_only=True)
        self.assertEqual(libro[san['sheet']].cell(fila_oro, indice + 1).value, 'Actualizado desde Data App')
        self.assertEqual(libro['Contactos Data App']['B2'].value, 'Contacto Oro Verde')
        libro.close()
        self.assertEqual(self.api(ruta)[1]['values'][san['columns'].index('RUBRO')], 'Rubro desde Excel')
        self.api('logout', {})
        self.assertEqual(self.api('login', consultor)[0], 200)
        self.assertEqual(self.api('events', {'name': 'Feria no autorizada'})[0], 403)
        contacto = next(a for a in self.api(ruta)[1]['activities'] if a['kind'] == 'contact')
        self.assertEqual(self.api(ruta, {'kind': 'contact', 'recordId': contacto['id'],
                                      'beforeDetails': contacto['details'], 'details': {'name': 'Contacto corregido'}})[0], 200)
        corregido = self.api(ruta)[1]['activities']
        self.assertEqual(next(a for a in corregido if a['id'] == contacto['id'])['details']['name'], 'Contacto corregido')
        self.assertEqual(corregido[0]['kind'], 'record_edit')
        self.api('logout', {})
        self.assertEqual(self.api('login', cuenta)[0], 200)
        status, feria = self.api('events', {'name': 'Feria de prueba', 'sheet': 'Empresas'})
        self.assertEqual(status, 201)
        self.assertEqual(self.api('companies?event=' + feria['id']), (200, []))
        self.assertEqual(self.api('events', {'name': 'FERIA DE PRUEBA'})[0], 409)
        cuenta_sdr = {**consultor, 'name': 'SDR de prueba', 'email': 'sdr@prueba.test', 'role': 'sdr', 'assignment': 'Vanessa'}
        status, sdr = self.api('users', cuenta_sdr)
        self.assertEqual(status, 201)
        marketing = {**consultor, 'name': 'Marketing de prueba', 'email': 'marketing@prueba.test', 'role': 'marketing', 'assignment': ''}
        self.assertEqual(self.api('users', marketing)[0], 201)
        self.api('logout', {})
        self.assertEqual(self.api('login', cuenta_sdr)[0], 200)
        self.assertEqual(self.api('me')[1]['user']['id'], sdr['user']['id'])
        sdr_empresas = self.api('companies?event=' + san['id'])[1]
        self.assertEqual(len(sdr_empresas), 150)
        self.assertTrue(any(e['id'] == oro['id'] and e['assigned'] for e in sdr_empresas))
        self.assertTrue(all(almacenamiento.nombre_normalizado(e['values'][san['columns'].index('SDR')]) == 'vanessa'
                            for e in sdr_empresas if e['assigned']))
        registro = next(a for a in self.api(ruta)[1]['activities'] if a['id'] == contacto['id'])
        edicion_ajena = {'kind': 'contact', 'recordId': registro['id'], 'beforeDetails': registro['details'],
                         'details': {'name': 'Cambio de otro rol'}}
        self.assertEqual(self.api(ruta, edicion_ajena)[0], 403)
        eliminar_ajeno = {'kind': 'record_delete', 'recordId': registro['id'], 'beforeDetails': registro['details']}
        self.assertEqual(self.api(ruta, eliminar_ajeno)[0], 403)
        visita_ajena = next(a for a in self.api(ruta)[1]['activities'] if a['kind'] == 'visit')
        self.assertEqual(self.api(ruta, {'kind': 'visit', 'recordId': visita_ajena['id'],
                                      'beforeDetails': visita_ajena['details'], 'details': {'status': 'PENDIENTE'}})[0], 403)
        self.assertEqual(self.api(ruta, {'kind': 'contact', 'details': {'name': 'Contacto del SDR'}})[0], 200)
        propio = next(a for a in self.api(ruta)[1]['activities'] if a['details'].get('name') == 'Contacto del SDR')
        eliminar_propio = {'kind': 'record_delete', 'recordId': propio['id'], 'beforeDetails': propio['details'],
                           'operationId': str(uuid.uuid4()), 'userId': sdr['user']['id']}
        self.assertEqual(self.api(ruta, eliminar_propio)[0], 200)
        self.assertEqual(self.api(ruta, eliminar_propio)[0], 200)
        self.assertNotIn(propio['id'], {a['id'] for a in self.api(ruta)[1]['activities']})
        self.assertEqual(self.api(ruta, {'kind': 'visit', 'details': {'status': 'PENDIENTE'}})[0], 200)
        visita_propia = next(a for a in self.api(ruta)[1]['activities'] if a['kind'] == 'visit')
        self.assertEqual(self.api(ruta, {'kind': 'record_delete', 'recordId': visita_propia['id'],
                                      'beforeDetails': visita_propia['details']})[0], 200)
        self.assertEqual(self.api(ruta)[1]['values'][san['columns'].index('STATUS VISITA')], 'REALIZADO')
        self.assertEqual(self.api('events/' + feria['id'], {'action': 'edit', 'name': 'Nombre no autorizado'})[0], 403)
        self.assertEqual(self.api('events/' + feria['id'], {'action': 'archive'})[0], 403)
        bitacora_sdr = self.api('activity')[1]['items']
        self.assertTrue(any(a['action'] == 'Contacto agregado' for a in bitacora_sdr))
        self.assertEqual({a['author'] for a in bitacora_sdr}, {cuenta_sdr['name']})
        self.api('logout', {})
        self.assertEqual(self.api('login', marketing)[0], 200)
        self.assertEqual(len(self.api('companies?event=' + san['id'])[1]), 150)
        self.assertEqual(self.api(ruta, edicion_ajena)[0], 200)
        registro_actualizado = next(a for a in self.api(ruta)[1]['activities'] if a['id'] == registro['id'])
        self.assertEqual(self.api(ruta, {**eliminar_ajeno, 'beforeDetails': registro_actualizado['details']})[0], 200)
        self.assertEqual(self.api('events/' + feria['id'], {'action': 'edit', 'name': 'Feria renombrada'})[0], 200)
        self.assertIn('Feria renombrada', {e['name'] for e in self.api('events')[1]})
        self.assertEqual(self.api('events/' + feria['id'], {'action': 'archive'})[0], 200)
        self.assertNotIn(feria['id'], {e['id'] for e in self.api('events')[1]})
        self.assertIn(feria['id'], {e['id'] for e in self.api('events/archived')[1]})
        self.assertEqual(self.api('events/' + feria['id'], {'action': 'restore'})[0], 200)
        self.assertIn(feria['id'], {e['id'] for e in self.api('events')[1]})
        with self.cliente.open(self.url + '/api/export?event=' + san['id']) as respuesta:
            self.assertEqual(respuesta.read(2), b'PK')
        madali = {**consultor, 'name': 'Madalí Alviso', 'email': 'madali@prueba.test', 'assignment': ''}
        self.assertEqual(self.api('users', madali)[0], 201)
        campo_consultor = san['columns'].index('CONSULTOR')
        valor_anterior = self.api(ruta)[1]['values'][campo_consultor]
        self.assertEqual(self.api(ruta, {'kind': 'edit', 'changes': [
            {'index': campo_consultor, 'before': valor_anterior, 'after': 'Sandra, Sofía, Madalí Alviso'},
        ]})[0], 200)
        acciones = {a['action'] for a in self.api('activity')[1]['items']}
        self.assertTrue({'Feria archivada', 'Feria restaurada', 'Feria editada', 'Excel exportado',
                         'Registro actualizado', 'Contacto eliminado', 'Visita eliminada'} <= acciones)
        self.api('logout', {})
        self.assertEqual(self.api('login', madali)[0], 200)
        self.assertIn(oro['id'], {e['id'] for e in self.api('companies?event=' + san['id'])[1] if e['assigned']})
        for archivo in ['catalogos.json', 'catalogo.json', 'dataapp.sqlite3']:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.cliente.open(self.url + '/' + archivo)
            self.assertEqual(error.exception.code, 404)


if __name__ == '__main__':
    unittest.main()
