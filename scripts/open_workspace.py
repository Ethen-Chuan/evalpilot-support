import fcntl
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
ADDRESS = 'http://127.0.0.1:4287'


def healthy():
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(ADDRESS + '/api/support/lab/state', timeout=4) as response:
            value = json.load(response)
        return value.get('protocol') == 'aftersales-replay-v1' and isinstance(value.get('versions'), list)
    except (OSError, ValueError, AttributeError):
        return False


def port_in_use():
    try:
        with socket.create_connection(('127.0.0.1', 4287), timeout=1):
            return True
    except OSError:
        return False


def main():
    if not (ROOT / 'dist/index.html').is_file():
        raise RuntimeError('页面文件缺失，请联系维护者重新生成；现有数据不会被修改。')
    runtime = ROOT / 'data/runtime'
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (runtime / 'launcher.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        child = None
        if not healthy() and not port_in_use():
            environment = os.environ.copy()
            environment.update(PORT='4287', EVAL_DATA_DIR=str(ROOT / 'data'), EVAL_MODEL_DIR=str(ROOT / 'data/models'))
            log_file = runtime / 'server.log'
            descriptor = os.open(log_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(descriptor, 'ab') as log:
                child = subprocess.Popen([sys.executable, str(ROOT / 'backend/server.py')], cwd=ROOT, env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            print('正在启动售后评测平台…', flush=True)
        deadline = time.monotonic() + 30
        while not healthy():
            if child is not None and child.poll() is not None:
                raise RuntimeError('平台启动失败，请联系维护者检查本机运行日志；没有重建或清空数据。')
            if time.monotonic() >= deadline:
                raise RuntimeError('平台未能就绪：端口可能被其他程序占用，或服务仍在启动。未关闭任何现有程序。')
            time.sleep(0.5)
    print('平台已就绪。关闭此窗口不会停止后台服务；电脑重启后可再次双击启动。', flush=True)
    if '--no-open' not in sys.argv[1:]:
        subprocess.run(['/usr/bin/open', ADDRESS + '/?view=recovered#guide'], check=True)


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as problem:
        print(str(problem), file=sys.stderr)
        sys.exit(1)
