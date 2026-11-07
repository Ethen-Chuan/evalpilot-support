import json
from pathlib import Path
import sys
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import server
from ontology import OntologyService

repository = SimpleNamespace(DATA=server.DATA_DIR, records=lambda kind: [], now=server.support_api.now, text=server.support_api.text, local_scan=server.support_api.local_scan)
server.support_api.ONTOLOGY = OntologyService(repository)
application = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
server.PORT = application.server_address[1]
print(json.dumps({'port': server.PORT}), flush=True)
application.serve_forever()
