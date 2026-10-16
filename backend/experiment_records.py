import json
import math


class ExperimentRecords:
    def __init__(self, repository):
        self.repo = repository

    def metadata(self, run, saved=None):
        percentage = run.get('trainingPercent', 100)
        default_name = {25: '小样本基线', 60: '扩充训练', 100: '全量训练'}.get(percentage, '历史训练') + f" · {run['total']}例回放"
        saved = saved or {}
        return {'name': saved.get('name') or default_name, 'customName': saved.get('name', ''), 'note': saved.get('note', ''), 'favorite': saved.get('favorite', False), 'archived': saved.get('archived', False), 'revision': saved.get('revision', 0), 'updatedAt': saved.get('updatedAt')}

    def summaries(self, project_id):
        if not isinstance(project_id, str) or not self.repo.get('corpus', project_id):
            raise ValueError('项目不存在')
        with self.repo.connection() as database:
            rows = database.execute("""SELECT json_object(
                'id', id, 'createdAt', json_extract(payload, '$.createdAt'),
                'status', json_extract(payload, '$.status'), 'total', json_extract(payload, '$.total'),
                'completed', json_extract(payload, '$.completed'), 'trainCount', json_extract(payload, '$.trainCount'),
                'trainingPercent', coalesce(json_extract(payload, '$.trainingPercent'), 100),
                'sourceHash', json_extract(payload, '$.sourceHash'), 'caseHash', json_extract(payload, '$.caseHash'),
                'protocol', json_extract(payload, '$.protocol'), 'metrics', json_extract(payload, '$.metrics'))
                FROM documents WHERE kind='cx_replay' AND json_extract(payload, '$.projectId')=?
                ORDER BY json_extract(payload, '$.createdAt') DESC, id DESC""", (project_id,)).fetchall()
        metadata = {record['id']: record for record in self.repo.records('cx_replay_meta') if record['projectId'] == project_id}
        records = [json.loads(row[0]) for row in rows]
        return [{**record, 'metadata': self.metadata(record, metadata.get(record['id']))} for record in records]

    def listing(self, query):
        project_id = query.get('project', [''])[0]
        search = query.get('q', [''])[0]
        scope = query.get('scope', ['active'])[0]
        status = query.get('status', ['all'])[0]
        training = query.get('training', ['all'])[0]
        if not isinstance(search, str) or len(search) > 200:
            raise ValueError('搜索内容最多200个字符')
        if scope not in ('active', 'favorites', 'archived') or status not in ('all', 'running', 'completed', 'failed', 'cancelled', 'interrupted') or training not in ('all', '25', '60', '100'):
            raise ValueError('实验筛选条件不正确')
        page_text = query.get('page', ['1'])[0]
        if not isinstance(page_text, str) or not page_text.isascii() or not page_text.isdecimal() or not 1 <= int(page_text) <= 1000000:
            raise ValueError('实验页码应为正整数')
        records = self.summaries(project_id)
        counts = {'all': len(records), 'active': sum(not record['metadata']['archived'] for record in records), 'favorites': sum(record['metadata']['favorite'] and not record['metadata']['archived'] for record in records), 'archived': sum(record['metadata']['archived'] for record in records)}
        needle = search.strip().casefold()
        matches = [record for record in records if record['metadata']['archived'] == (scope == 'archived') and (scope != 'favorites' or record['metadata']['favorite']) and (status == 'all' or record['status'] == status) and (training == 'all' or record['trainingPercent'] == int(training)) and (not needle or needle in '\n'.join([record['id'], record['createdAt'], record['metadata']['name'], record['metadata']['note']]).casefold())]
        pages = max(1, math.ceil(len(matches) / 10))
        page = min(int(page_text), pages)
        fields = ('id', 'createdAt', 'status', 'total', 'completed', 'trainCount', 'trainingPercent', 'metadata')
        return {'records': [{key: record[key] for key in fields} for record in matches[(page - 1) * 10:page * 10]], 'total': len(matches), 'page': page, 'pages': pages, 'pageSize': 10, 'counts': counts}

    def checked(self, project_id, identifier, revision):
        if not isinstance(project_id, str) or not self.repo.get('corpus', project_id) or not isinstance(identifier, str):
            raise ValueError('项目或记录不存在')
        run = self.repo.get('cx_replay', identifier)
        if not run or run['projectId'] != project_id:
            raise ValueError('该实验不属于当前项目')
        saved = self.repo.get('cx_replay_meta', identifier) or {'id': identifier, 'projectId': project_id, 'revision': 0}
        if type(revision) is not int or revision != saved['revision']:
            raise ValueError('记录已在其他页面修改，请刷新记录后重试')
        return run, saved

    def update(self, body, clean):
        if not isinstance(body, dict) or set(body) - {'projectId', 'id', 'revision', 'name', 'note', 'favorite'} or not any(key in body for key in ('name', 'note', 'favorite')):
            raise ValueError('只能修改实验名称、备注或收藏')
        changes = {}
        for key, maximum in (('name', 80), ('note', 500)):
            if key in body:
                value = body[key]
                if not isinstance(value, str) or len(value) > maximum:
                    raise ValueError('名称最多80字，备注最多500字')
                changes[key] = clean(value, maximum) if value.strip() else ''
        if 'favorite' in body:
            if type(body['favorite']) is not bool:
                raise ValueError('收藏状态应为布尔值')
            changes['favorite'] = body['favorite']
        with self.repo.LOCK:
            run, saved = self.checked(body.get('projectId'), body.get('id'), body.get('revision'))
            saved.update(**changes, revision=saved['revision'] + 1, updatedAt=self.repo.now())
            self.repo.save('cx_replay_meta', run['id'], saved)
        return {'id': run['id'], 'metadata': self.metadata(run, saved)}

    def archive(self, body):
        if not isinstance(body, dict) or set(body) - {'projectId', 'records', 'archived', 'confirmed'} or body.get('confirmed') is not True or type(body.get('archived')) is not bool:
            raise ValueError('请确认归档或恢复操作')
        entries = body.get('records')
        if not isinstance(entries, list) or not 1 <= len(entries) <= 100 or any(not isinstance(entry, dict) or set(entry) != {'id', 'revision'} or not isinstance(entry['id'], str) for entry in entries):
            raise ValueError('一次请选择1至100条实验记录')
        if len({entry['id'] for entry in entries}) != len(entries):
            raise ValueError('不可重复选择同一实验')
        with self.repo.LOCK:
            checked = [self.checked(body.get('projectId'), entry['id'], entry['revision']) for entry in entries]
            if body['archived'] and any(run['status'] == 'running' for run, saved in checked):
                raise ValueError('运行中的实验不能归档，请先等待完成或停止回放')
            updated = []
            with self.repo.connection() as database:
                for run, saved in checked:
                    saved.update(archived=body['archived'], revision=saved['revision'] + 1, updatedAt=self.repo.now())
                    database.execute('INSERT OR REPLACE INTO documents(kind,id,payload) VALUES (?,?,?)', ('cx_replay_meta', run['id'], json.dumps(saved, ensure_ascii=False)))
                    updated.append({'id': run['id'], 'metadata': self.metadata(run, saved)})
        return {'records': updated}
