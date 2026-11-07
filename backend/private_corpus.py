import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import uuid

from corpus_import import checked_records, import_corpus, scan_file
import quality_corpus


ROOT = Path(__file__).resolve().parents[1]
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_PACKAGE_BYTES = 128 * 1024 * 1024


def config_path():
    return Path(os.environ.get('EVAL_PRIVATE_CORPUS_CONFIG', str(ROOT.parent / '.evalpilot-local-data/registry.json'))).expanduser()


def validate_location(path):
    if path.resolve().is_relative_to(ROOT) or path.is_symlink():
        raise ValueError('私有数据登记和缓存必须放在源码仓库之外，且不能使用符号链接登记文件')


def validate_entry(entry):
    fields = {
        'repository': r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}',
        'datasetId': r'[a-z][a-z0-9-]{2,79}',
        'commit': r'[a-f0-9]{40}',
        'manifestSha256': r'[a-f0-9]{64}',
    }
    if not isinstance(entry, dict) or set(entry) != set(fields):
        raise ValueError('私有数据登记字段不完整或包含未知字段')
    if any(not isinstance(entry[key], str) or not re.fullmatch(pattern, entry[key]) for key, pattern in fields.items()):
        raise ValueError('私有数据登记必须使用合法项目编号、完整版本号和内容指纹')
    return entry


def read_registry(path):
    if not path.exists():
        return {'schemaVersion': 1, 'datasets': []}
    if path.is_symlink() or path.stat().st_size > 65536:
        raise ValueError('私有数据登记文件不合法')
    registry = json.loads(path.read_text())
    if registry.get('schemaVersion') != 1 or not isinstance(registry.get('datasets'), list):
        raise ValueError('私有数据登记版本不受支持')
    identifiers = [validate_entry(entry)['datasetId'] for entry in registry['datasets']]
    if len(identifiers) != len(set(identifiers)):
        raise ValueError('私有数据登记包含重复项目')
    return registry


def github_bytes(endpoint, limit=MAX_FILE_BYTES, raw=False):
    command = ['gh', 'api', '--hostname', 'github.com', endpoint]
    if raw:
        command += ['-H', 'Accept: application/vnd.github.raw+json']
    environment = os.environ.copy()
    environment.pop('GH_DEBUG', None)
    result = subprocess.run(command, capture_output=True, timeout=120, env=environment)
    if result.returncode or len(result.stdout) > limit:
        raise ValueError('无法读取私有仓库或文件超限；请检查 GitHub 登录和仓库权限')
    return result.stdout


def github_json(endpoint):
    return json.loads(github_bytes(endpoint, limit=1024 * 1024))


def verify_access(repository):
    account = github_json('user')
    remote = github_json('repos/' + repository)
    owner = remote.get('owner', {})
    if not remote.get('private') or remote.get('visibility') != 'private' or owner.get('type') != 'User' or owner.get('login') != account.get('login') or not remote.get('permissions', {}).get('admin') or remote.get('full_name', '').casefold() != repository.casefold() or remote.get('fork') or remote.get('has_pages'):
        raise ValueError('数据仓库必须是当前账户独立拥有的非公开个人仓库，且未开启公开页面')
    collaborators = github_json('repos/' + repository + '/collaborators?per_page=100')
    invitations = github_json('repos/' + repository + '/invitations?per_page=100')
    keys = github_json('repos/' + repository + '/keys?per_page=100')
    actions = github_json('repos/' + repository + '/actions/permissions')
    if not isinstance(collaborators, list) or any(person.get('login') != owner['login'] for person in collaborators) or invitations != [] or keys != [] or actions.get('enabled') is not False:
        raise ValueError('发现其他访问授权或自动工作流，已停止获取私有数据；请先检查仓库权限')
    return {'owner': owner['login'], 'private': True, 'otherCollaborators': 0, 'pendingInvitations': 0, 'deployKeys': 0, 'actionsEnabled': False}


def package_manifest(directory, entry):
    manifest_path = directory / 'manifest.json'
    if manifest_path.is_symlink() or not manifest_path.is_file() or manifest_path.stat().st_size > 65536:
        raise ValueError('私有数据清单缺失或不合法')
    if hashlib.sha256(manifest_path.read_bytes()).hexdigest() != entry['manifestSha256']:
        raise ValueError('私有数据清单与已登记指纹不一致，未导入')
    scan_file(manifest_path)
    manifest = json.loads(manifest_path.read_text())
    files = manifest.get('files', [])
    if manifest.get('id') != entry['datasetId'] or manifest.get('schemaVersion') != 1 or manifest.get('scanStatus') != 'passed' or manifest.get('quarantined') or not 1 <= len(files) <= 32:
        raise ValueError('私有数据清单的来源、完整性或扫描状态不符合要求')
    names = set()
    for item in files:
        name = item.get('name', '')
        if not re.fullmatch(r'[a-zA-Z0-9_-]+_redacted\.jsonl', name) or name in names or not re.fullmatch(r'[a-f0-9]{64}', item.get('sha256', '')):
            raise ValueError('私有数据文件名或指纹不合法')
        names.add(name)
    return manifest


def check_package(directory, entry):
    if directory.is_symlink():
        raise ValueError('私有数据缓存不能是符号链接')
    manifest = package_manifest(directory, entry)
    expected = {'manifest.json'} | {item['name'] for item in manifest['files']}
    if {item.name for item in directory.iterdir()} != expected:
        raise ValueError('私有数据缓存包含未登记文件')
    total_bytes = 0
    for item in manifest['files']:
        source = directory / item['name']
        if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_FILE_BYTES:
            raise ValueError('私有数据文件缺失、不合法或超限')
        total_bytes += source.stat().st_size
    if total_bytes > MAX_PACKAGE_BYTES:
        raise ValueError('私有数据包超限')
    return quality_corpus.checked_quality_records(directory)[0] if manifest.get('kind') == quality_corpus.KIND else checked_records(directory)[0]


def cached_package(entry, home):
    parent = home / 'cache' / entry['datasetId']
    target = parent / entry['commit']
    if target.exists():
        check_package(target, entry)
        return target
    verify_access(entry['repository'])
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix='.download-', dir=parent) as temporary:
        folder = Path(temporary)
        prefix = f"repos/{entry['repository']}/contents/packages/{entry['datasetId']}/"
        suffix = '?ref=' + entry['commit']
        (folder / 'manifest.json').write_bytes(github_bytes(prefix + 'manifest.json' + suffix, limit=65536, raw=True))
        manifest = package_manifest(folder, entry)
        total_bytes = 0
        for item in manifest['files']:
            content = github_bytes(prefix + item['name'] + suffix, raw=True)
            total_bytes += len(content)
            if total_bytes > MAX_PACKAGE_BYTES or hashlib.sha256(content).hexdigest() != item['sha256']:
                raise ValueError('下载数据超限或与登记指纹不一致')
            (folder / item['name']).write_bytes(content)
        check_package(folder, entry)
        for source in folder.iterdir():
            source.chmod(0o600)
        folder.rename(target)
    return target


def register(entry, path=None):
    entry = validate_entry(entry)
    path = path or config_path()
    validate_location(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (path.parent / '.restore.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        registry = read_registry(path)
        previous = next((item for item in registry['datasets'] if item['datasetId'] == entry['datasetId']), None)
        if previous and previous != entry:
            raise ValueError('这个项目已经固定了另一版本；不会自动更换数据或覆盖历史')
        access = verify_access(entry['repository'])
        cached_package(entry, path.parent)
        if not previous:
            registry['datasets'].append(entry)
            with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
                json.dump(registry, stream, ensure_ascii=False, indent=2)
                temporary = Path(stream.name)
            temporary.chmod(0o600)
            temporary.replace(path)
    return access


def already_imported(repository, entry):
    if repository.get('quality_corpus', entry['datasetId']):
        return quality_corpus.already_imported(repository, entry)
    corpus = repository.get('corpus', entry['datasetId'])
    if not corpus:
        return False
    if corpus.get('privateSource') != entry:
        if corpus.get('privateSource'):
            raise ValueError('本机项目与登记的私有数据版本不同，未覆盖历史资料')
        return False
    with repository.connection() as database:
        count, messages = database.execute("SELECT COUNT(*), COALESCE(SUM(json_array_length(payload,'$.messages')),0) FROM documents WHERE kind='imported_dialogue' AND json_extract(payload,'$.datasetId')=?", (entry['datasetId'],)).fetchone()
    return count == corpus['totals']['sessions'] and messages == corpus['totals']['messages']


def restore_registered(repository, path=None):
    path = path or config_path()
    if not path.exists():
        return []
    validate_location(path)
    results = []
    with (path.parent / '.restore.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for entry in read_registry(path)['datasets']:
            if already_imported(repository, entry):
                results.append({'datasetId': entry['datasetId'], 'status': 'already_present', 'inserted': 0})
                continue
            directory = cached_package(entry, path.parent)
            backup = path.parent / 'backups' / ('before-restore-' + uuid.uuid4().hex + '.sqlite3')
            manifest = package_manifest(directory, entry)
            if manifest.get('kind') == quality_corpus.KIND:
                result = quality_corpus.import_quality_corpus(directory, repository, backup, entry)
            else:
                result = import_corpus(directory, repository, backup)
                corpus = repository.get('corpus', entry['datasetId'])
                repository.save('corpus', entry['datasetId'], {**corpus, 'privateSource': entry})
            results.append({**result, 'status': 'restored'})
    return results


def restore_at_startup(repository):
    try:
        results = restore_registered(repository)
        if results:
            print('私有项目集已检查：本机已有数据直接保留，缺失项目已按登记版本恢复。', flush=True)
        return results
    except Exception:
        print('私有项目集恢复未完成，现有数据未清空。请运行 scripts/private_dataset.py restore 检查登录、扫描器或登记文件。', flush=True)
        return [{'status': 'attention_required'}]
