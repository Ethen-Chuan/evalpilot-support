import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from private_corpus import config_path, read_registry, register, restore_registered, verify_access


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description='登记、检查或恢复个人私有项目集；从不上传数据或调用模型')
    parser.add_argument('--config', type=Path, default=config_path())
    commands = parser.add_subparsers(dest='command', required=True)
    registration = commands.add_parser('register')
    registration.add_argument('--repository', required=True)
    registration.add_argument('--dataset-id', required=True)
    registration.add_argument('--commit', required=True)
    registration.add_argument('--manifest-sha256', required=True)
    commands.add_parser('restore')
    commands.add_parser('check-access')
    options = parser.parse_args()
    if options.command == 'register':
        entry = {'repository': options.repository, 'datasetId': options.dataset_id, 'commit': options.commit, 'manifestSha256': options.manifest_sha256}
        print(json.dumps(register(entry, options.config), ensure_ascii=False))
    elif options.command == 'check-access':
        print(json.dumps([verify_access(entry['repository']) for entry in read_registry(options.config)['datasets']], ensure_ascii=False))
        return
    import support_api
    support_api.DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    with support_api.connection() as database:
        database.execute('CREATE TABLE IF NOT EXISTS documents(kind TEXT,id TEXT,payload TEXT,PRIMARY KEY(kind,id))')
    support_api.DIALOGUES.initialize_index()
    print(json.dumps(restore_registered(support_api, options.config), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, ValueError) else '私有数据操作未完成；请检查 GitHub 登录、网络、文件权限和本机扫描器。未清空现有数据。', file=sys.stderr)
        sys.exit(1)
