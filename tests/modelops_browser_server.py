import os
from pathlib import Path
import sys
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ['EVAL_DATA_DIR']).resolve()
if DATA == (ROOT / 'data').resolve() or not DATA.name.startswith('modelops-browser-'):
    raise RuntimeError('Only an isolated ModelOps browser fixture database is permitted')
sys.path.insert(0, str(ROOT / 'backend'))
import server
import support_api

server.initialize()
support_api.initialize()
print('Isolated ModelOps sandbox ready; no external model calls', flush=True)
ThreadingHTTPServer(('127.0.0.1', server.PORT), server.Handler).serve_forever()
