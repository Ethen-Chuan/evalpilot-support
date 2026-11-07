import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import server

server.support_api.initialize()
application = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
server.PORT = application.server_address[1]
print(json.dumps({'port': server.PORT}), flush=True)
application.serve_forever()
