import hashlib
import io
import json
from pathlib import Path
import tarfile

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
ARCHIVE_URL = 'https://amazon-visual-anomaly.s3.us-west-2.amazonaws.com/VisA_20220922.tar'
RANGES = [(1000000000, 'visa-range.bin'), (1250000000, 'visa-range-1250.bin'), (1600000000, 'visa-range-1600.bin'), (1850000000, 'visa-range-1850.bin')]


def prepare():
    destination = ROOT / 'backend' / 'public_vision'
    manifest = []
    for category, (base, filename) in enumerate(RANGES, 1):
        raw = (Path('/private/tmp') / filename).read_bytes()
        accepted = 0
        for offset in range((-base) % 512, len(raw) - 512, 512):
            header = raw[offset:offset + 512]
            if header[257:262] != b'ustar':
                continue
            entry = tarfile.TarInfo.frombuf(header, 'utf8', 'strict')
            if not entry.isfile() or not entry.name.startswith(f'pcb{category}/Data/Images/Normal/') or not entry.name.endswith('.JPG'):
                continue
            image_bytes = raw[offset + 512:offset + 512 + entry.size]
            if len(image_bytes) != entry.size:
                continue
            with Image.open(io.BytesIO(image_bytes)) as original:
                original.load()
                upright = ImageOps.exif_transpose(original).convert('RGB')
                upright.thumbnail((960, 960), Image.Resampling.LANCZOS)
                clean = Image.new('RGB', upright.size)
                clean.paste(upright)
                name = f'board-{category}-{accepted + 1}_redacted.png'
                target = destination / name
                clean.save(target, format='PNG')
            manifest.append({'file': name, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'sourceFile': entry.name, 'sourceUrl': ARCHIVE_URL, 'sourceRange': [base + offset + 512, base + offset + 511 + entry.size], 'sourceSha256': hashlib.sha256(image_bytes).hexdigest(), 'category': f'pcb{category}', 'sourceLabel': 'Normal', 'changes': '完整物体照片缩至最长边960像素，去除元数据；没有增加缺陷或标注边框。'})
            accepted += 1
            if accepted == 5:
                break
        if accepted != 5:
            raise ValueError(f'Expected five complete photos in range {base}')
    (destination / 'photo-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(f'Prepared {len(manifest)} distinct public photos; manual review required before allowlisting.')


if __name__ == '__main__':
    prepare()
