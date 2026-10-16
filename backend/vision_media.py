import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import warnings

from PIL import Image, ImageDraw, ImageFont, ImageOps
from public_vision import exact_public_review


Image.MAX_IMAGE_PIXELS = 6_000_000
COMPILE_LOCK = threading.Lock()


def calibration_png(text='V7Q'):
    image = Image.new('RGB', (640, 320), '#f1f4f8')
    painter = ImageDraw.Draw(image)
    font_path = '/System/Library/Fonts/Menlo.ttc'
    font = ImageFont.truetype(font_path, 76) if Path(font_path).exists() else ImageFont.load_default(size=76)
    small = ImageFont.truetype(font_path, 22) if Path(font_path).exists() else ImageFont.load_default(size=22)
    painter.text((36, 28), 'LOCAL TEST / NOT CUSTOMER DATA', fill='#425068', font=small)
    painter.rounded_rectangle((32, 78, 608, 280), radius=18, fill='#132433')
    painter.text((90, 126), text, fill='#82e1b8', font=font)
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def normalize_image(data_url):
    if not isinstance(data_url, str) or len(data_url) > 5_700_000:
        raise ValueError('图片过大，只接受不超过 4MB 的 PNG / JPEG')
    match = re.fullmatch(r'data:image/(png|jpeg);base64,([A-Za-z0-9+/=]+)', data_url)
    if not match:
        raise ValueError('只接受本地 PNG / JPEG，不下载外部图片链接')
    try:
        raw = base64.b64decode(match[2], validate=True)
        if len(raw) > 4_000_000:
            raise ValueError('图片过大')
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as original:
                if original.format not in ('PNG', 'JPEG') or getattr(original, 'n_frames', 1) != 1:
                    raise ValueError('图片格式不支持')
                original.load()
                if original.width < 32 or original.height < 32 or original.width * original.height > 6_000_000:
                    raise ValueError('图片尺寸不合格')
                upright = ImageOps.exif_transpose(original).convert('RGB')
                clean = Image.new('RGB', upright.size)
                clean.paste(upright)
                buffer = io.BytesIO()
                clean.save(buffer, format='PNG')
                content = buffer.getvalue()
                if len(content) > 4_000_000:
                    raise ValueError('图片重编码后超过上限，请先压缩')
                return content, clean.width, clean.height
    except Exception:
        raise ValueError('无法可靠读取图片，或尺寸/格式超过限制；未保存、未外发') from None


def local_image_check(content, repository, generated_text=None):
    public_review = exact_public_review(content)
    if generated_text is not None:
        if not isinstance(generated_text, str) or not re.fullmatch(r'E0[49]|[A-F0-9]{4}', generated_text) or content != calibration_png(generated_text):
            raise ValueError('程序绘图来源与实际图片不一致，不能替代上传图片检查')
        repository.local_scan(['LOCAL TEST / NOT CUSTOMER DATA', generated_text])
    folder = repository.DATA / 'runtime'
    folder.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).with_name('image_ocr.swift')
    binary = folder / ('image-ocr-' + hashlib.sha256(source.read_bytes()).hexdigest()[:12])
    with COMPILE_LOCK:
        if public_review is None and generated_text is None and not binary.exists():
            result = subprocess.run(['/usr/bin/swiftc', '-module-cache-path', str(folder / 'swift-cache'), str(source), '-o', str(binary)], capture_output=True, timeout=90)
            if result.returncode:
                raise ValueError('本机图片文字扫描器不可用；请联系维护者，不允许跳过检查')
    with tempfile.TemporaryDirectory(prefix='image-privacy-') as temporary:
        image_path = Path(temporary) / 'image.png'
        image_path.write_bytes(content)
        text = None
        if public_review is None and generated_text is None:
            result = subprocess.run([str(binary), str(image_path)], capture_output=True, timeout=30)
            if result.returncode:
                raise ValueError('本机图片文字识别失败，未保存或外发；请修复扫描器后重试，不能跳过真实图片检查')
            try:
                text = json.loads(result.stdout)['text']
            except (ValueError, KeyError):
                raise ValueError('图片扫描结果不完整，未保存或外发') from None
            repository.local_scan([text])
        candidates = [Path(os.environ['EVAL_DLP_PATH'])] if os.environ.get('EVAL_DLP_PATH') else []
        candidates += [Path.home() / '.config/ept/codex/dlp/dlp', Path.home() / '.codex/dlp/dlp']
        scanner = next((item for item in candidates if item.is_file()), None)
        if not scanner:
            raise ValueError('图片脱敏扫描器不可用')
        scan = subprocess.run([str(scanner), 'report', str(image_path)], capture_output=True, text=True, timeout=30)
        report = scan.stdout + scan.stderr
        levels = [int(value) for value in re.findall(r'\[S([0-4])\]', report)]
        if re.search(r'最高风险\s*S0', report) and scan.returncode == 0:
            pass
        elif scan.returncode != 0 or not levels or max(levels) > 2 or any('需要人工复核的视觉内容' not in line for line in report.splitlines() if re.search(r'\[S[1-4]\]', line)):
            raise ValueError('图片扫描存在风险或不支持的内容，请在原文件副本中脱敏后重试')
        return {'automaticTextScan': 'not_run_fixed_public_review' if public_review else 'generated_text_scanned' if generated_text else 'passed', 'visualReviewRequired': not bool(public_review or generated_text), 'metadataRemoved': True, 'ocrCharacters': len(text) if text is not None else None, 'publicReview': public_review, 'generatedTextVerified': generated_text is not None}


def image_url(content):
    return 'data:image/png;base64,' + base64.b64encode(content).decode('ascii')
