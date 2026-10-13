import argparse
import collections
import datetime
import hashlib
import json
from pathlib import Path
import subprocess


def verify(directory, audit):
    audit.mkdir(parents=True, exist_ok=True)
    manifest_path = directory / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if 'redactions' in manifest:
        (audit / 'redaction-counters.json').write_text(json.dumps(manifest.pop('redactions'), ensure_ascii=False, indent=2))
    scanner = Path.home() / '.config/ept/codex/dlp/dlp'
    totals = collections.Counter()
    identifiers = set()
    message_identifiers = set()
    receipts = []
    lengths = []
    for entry in manifest['files']:
        source = directory / entry['name']
        if source.name != entry['name'] or hashlib.sha256(source.read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError('Corpus fingerprint mismatch')
        result = subprocess.run([str(scanner), 'scan', str(source)], capture_output=True, text=True, timeout=240)
        if result.returncode:
            raise ValueError('Scanner did not complete')
        report = json.loads(result.stdout)
        (audit / (source.stem + '.scan.json')).write_text(result.stdout)
        if report['max_severity'] != 0 or report.get('findings'):
            raise ValueError('Residual findings; corpus remains pending')
        rows = [json.loads(line) for line in source.open() if line.strip()]
        if len(rows) != entry['sessions']:
            raise ValueError('File record count mismatch')
        for row in rows:
            if row['id'] in identifiers:
                raise ValueError('Duplicate dialogue')
            identifiers.add(row['id'])
            lengths.append(len(row['messages']))
            if row['provenance']['declaredMessages'] != len(row['messages']):
                raise ValueError('Message count mismatch')
            totals['sessions'] += 1
            totals['messages'] += len(row['messages'])
            totals['finalAnnotations'] += sum(annotation['state'] == 'final' for annotation in row['annotationSets'])
            totals['draftAnnotations'] += sum(annotation['state'] == 'draft' for annotation in row['annotationSets'])
            for sequence, message in enumerate(row['messages'], 1):
                if sequence != message['sequence'] or message['id'] in message_identifiers or message['traceId'] is not None:
                    raise ValueError('Message identity, order or provenance mismatch')
                message_identifiers.add(message['id'])
                if 'https://' in message['content'].lower() or 'http://' in message['content'].lower() or '<img' in message['content'].lower():
                    raise ValueError('Unreviewed remote media reference')
        receipts.append({'file': source.name, 'sha256': entry['sha256'], 'maxSeverity': report['max_severity'], 'sessions': len(rows)})
        print(json.dumps({'file': source.name, 'maxSeverity': 0, 'sessions': len(rows)}), flush=True)
    for field, count in totals.items():
        if count != manifest['totals'][field]:
            raise ValueError('Manifest aggregate mismatch')
    manifest.update(scanStatus='passed', scanStatement='自动规则未发现明确敏感项；对外展示前仍需业务人工复核', scanReceipts=receipts, verifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), messageRange=[min(lengths), max(lengths)])
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    report = subprocess.run([str(scanner), 'scan', str(manifest_path)], capture_output=True, text=True, timeout=60)
    scanned = json.loads(report.stdout) if report.returncode == 0 else None
    (audit / 'manifest.scan.json').write_text(report.stdout)
    if not scanned or scanned['max_severity'] != 0 or scanned.get('findings'):
        manifest['scanStatus'] = 'pending_manifest_review'
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
        raise ValueError('Manifest requires review; corpus remains pending')
    print(json.dumps({'verified': dict(totals), 'messageRange': manifest['messageRange']}, ensure_ascii=False))
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--audit', type=Path, required=True)
    options = parser.parse_args()
    verify(options.directory, options.audit)
