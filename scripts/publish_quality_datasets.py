import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from private_corpus import github_bytes, github_json, verify_access
from quality_corpus import checked_quality_records


def write_github(endpoint, body, method='POST'):
    environment = os.environ.copy()
    environment.pop('GH_DEBUG', None)
    result = subprocess.run(['gh', 'api', '--hostname', 'github.com', '--method', method, endpoint, '--input', '-'], input=json.dumps(body).encode(), capture_output=True, timeout=120, env=environment)
    if result.returncode:
        raise ValueError('私有仓库写入未完成；未强制覆盖远端版本，请检查权限或并发更新')
    return json.loads(result.stdout)


def publish(repository, directories):
    packages = [(directory, checked_quality_records(directory)[0]) for directory in directories]
    if len({manifest['id'] for directory, manifest in packages}) != len(packages):
        raise ValueError('不能重复上传同一数据包')
    verify_access(repository)
    prefix = 'repos/' + repository
    branch = github_json(prefix)['default_branch']
    reference = prefix + '/git/refs/heads/' + quote(branch, safe='')
    parent = github_json(prefix + '/git/ref/heads/' + quote(branch, safe=''))['object']['sha']
    parent_tree = github_json(prefix + '/git/commits/' + parent)['tree']['sha']
    remote_tree = github_json(prefix + '/git/trees/' + parent_tree + '?recursive=1')
    if remote_tree.get('truncated'):
        raise ValueError('无法完整核对远端目录，已停止上传')
    existing = {item['path']: item['sha'] for item in remote_tree['tree'] if item['type'] == 'blob'}
    files = []
    for directory, manifest in packages:
        package_prefix = 'packages/' + manifest['id'] + '/'
        names = ['manifest.json'] + [item['name'] for item in manifest['files']]
        if any(path.startswith(package_prefix) and path.removeprefix(package_prefix) not in names for path in existing):
            raise ValueError('远端同名数据包含额外文件，未覆盖')
        for name in names:
            content = (directory / name).read_bytes()
            if name == 'manifest.json':
                if json.loads(content) != manifest:
                    raise ValueError('复核后清单发生变化，已停止上传')
            elif hashlib.sha256(content).hexdigest() != next(item['sha256'] for item in manifest['files'] if item['name'] == name):
                raise ValueError('复核后文件发生变化，已停止上传')
            path = package_prefix + name
            blob_hash = hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\0' + content).hexdigest()
            if path in existing and existing[path] != blob_hash:
                raise ValueError('远端已有不同内容，请使用新的数据版本编号')
            files.append((path, content, path not in existing))
    updates = []
    for path, content, new in files:
        if new:
            blob = write_github(prefix + '/git/blobs', {'content': base64.b64encode(content).decode(), 'encoding': 'base64'})
            updates.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
    commit = parent
    if updates:
        tree = write_github(prefix + '/git/trees', {'base_tree': parent_tree, 'tree': updates})
        commit = write_github(prefix + '/git/commits', {'message': 'Add reviewed quality inspection datasets', 'tree': tree['sha'], 'parents': [parent]})['sha']
        write_github(reference, {'sha': commit, 'force': False}, method='PATCH')
    verify_access(repository)
    for path, content, new in files:
        downloaded = github_bytes(prefix + '/contents/' + path + '?ref=' + commit, raw=True)
        if downloaded != content:
            raise ValueError('远端文件与本机复核副本不一致，未登记恢复源')
    return [{'repository': repository, 'datasetId': manifest['id'], 'commit': commit, 'manifestSha256': hashlib.sha256((directory / 'manifest.json').read_bytes()).hexdigest()} for directory, manifest in packages]


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='仅将全量复扫通过的质检文本包上传到本人私有仓库，不接受原始表格')
    parser.add_argument('--repository', required=True)
    parser.add_argument('--directory', type=Path, action='append', required=True)
    parser.add_argument('--confirmed-reviewed', action='store_true')
    options = parser.parse_args()
    try:
        if not options.confirmed_reviewed:
            raise ValueError('上传前必须完成脱敏与人工复核，并显式确认')
        print(json.dumps(publish(options.repository, options.directory), ensure_ascii=False))
    except Exception as error:
        print(str(error) if isinstance(error, ValueError) else '私有数据上传未完成，不输出远端内容或凭证。', file=sys.stderr)
        sys.exit(1)
