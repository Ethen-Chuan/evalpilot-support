import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_PORTS = (4287, 4290, 4291, 4293, 4294, 4295, 4296, 4297, 4298, 4299)


def runtime_hash():
    files = json.loads((ROOT / 'backend/simulator_runtime.json').read_text())
    hashes = {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in files}
    return hashlib.sha256(json.dumps(hashes, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def healthy(port):
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        address = f'http://127.0.0.1:{port}'
        with opener.open(address + '/api/support/lab/state', timeout=4) as response:
            value = json.load(response)
        with opener.open(address + '/api/support/simulator/health', timeout=4) as response:
            simulator = json.load(response)
        with opener.open(address + '/api/support/ontology/health', timeout=4) as response:
            ontology = json.load(response)
        return (
            value.get('protocol') == 'aftersales-replay-v1'
            and isinstance(value.get('versions'), list)
            and simulator.get('protocol') == 'support-simulator-v2'
            and simulator.get('rubricVersion') == 'support-rubric-v2'
            and simulator.get('connectionProtocol') == 'support-providers-qwen-v1'
            and simulator.get('available') is True
            and simulator.get('runtimeHash') == runtime_hash()
            and isinstance(simulator.get('providers'), list)
            and all(provider in simulator['providers'] for provider in ('deepseek', 'qwen'))
            and ontology.get('protocol') == 'ontology-graph-v1'
            and ontology.get('available') is True
            and ontology.get('domainProtocol') == 'ontology-domain-v1'
        )
    except (OSError, ValueError, AttributeError):
        return False


def port_in_use(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            return True
    except OSError:
        return False


def select_port():
    for port in WORKSPACE_PORTS:
        if healthy(port):
            return port
    for port in WORKSPACE_PORTS:
        if not port_in_use(port):
            return port
    raise RuntimeError('本机工作区端口被旧版服务或其他程序占用，未关闭任何进程。请先停止旧服务后重新打开。')


def main():
    if not (ROOT / 'dist/index.html').is_file():
        raise RuntimeError('页面文件缺失，请联系维护者重新生成；现有数据不会被修改。')
    runtime = ROOT / 'data/runtime'
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (runtime / 'launcher.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        port = select_port()
        address = f'http://127.0.0.1:{port}'
        child = None
        if not healthy(port) and not port_in_use(port):
            environment = os.environ.copy()
            environment.update(PORT=str(port), EVAL_DATA_DIR=str(ROOT / 'data'), EVAL_MODEL_DIR=str(ROOT / 'data/models'))
            log_file = runtime / 'server.log'
            descriptor = os.open(log_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(descriptor, 'ab') as log:
                child = subprocess.Popen([sys.executable, str(ROOT / 'backend/server.py')], cwd=ROOT, env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            print('正在启动售后评测平台…', flush=True)
        deadline = time.monotonic() + 300
        while not healthy(port):
            if child is not None and child.poll() is not None:
                raise RuntimeError('平台启动失败，请联系维护者检查本机运行日志；没有重建或清空数据。')
            if time.monotonic() >= deadline:
                raise RuntimeError('平台未能就绪：端口可能被其他程序占用，或服务仍在启动。未关闭任何现有程序。')
            time.sleep(0.5)
    print(f'平台已就绪：{address}。关闭此窗口不会停止后台服务；电脑重启后可再次双击启动。', flush=True)
    if port != WORKSPACE_PORTS[0]:
        print('优先端口仍由旧服务占用，已保留旧进程并使用备用端口。请只在新地址操作，项目数据目录不变；旧进程内存中的密钥需要重新填写。', flush=True)
    if '--no-open' not in sys.argv[1:]:
        subprocess.run(['/usr/bin/open', address + '/?view=recovered#service'], check=True)


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as problem:
        print(str(problem), file=sys.stderr)
        sys.exit(1)
