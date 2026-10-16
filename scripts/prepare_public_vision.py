import argparse
import hashlib
from pathlib import Path

from PIL import Image


SOURCE_HASH = 'd707e2e95d3b98336c99e2b8aa6049f65f1f7044542f2839a63df74b9ba3a629'
CROPS = {
    'pcb-overview_redacted.png': (4, 49, 155, 153),
    'pcb-pins_redacted.png': (4, 279, 155, 379),
    'pcb-chip_redacted.png': (166, 279, 316, 379),
    'pcb-component_redacted.png': (493, 279, 644, 379),
}


def prepare(source, destination):
    if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_HASH:
        raise ValueError('Source does not match the reviewed VisA illustration')
    destination.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as original:
        original.load()
        for name, bounds in CROPS.items():
            rectangle = tuple(round(value * (original.width / 975 if index % 2 == 0 else original.height / 768)) for index, value in enumerate(bounds))
            crop = original.crop(rectangle).convert('RGB')
            clean = Image.new('RGB', crop.size)
            clean.paste(crop)
            target = destination / name
            clean.save(target, format='PNG')
            print(name, clean.size, hashlib.sha256(target.read_bytes()).hexdigest())


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    arguments = parser.parse_args()
    prepare(arguments.source, Path(__file__).resolve().parents[1] / 'backend' / 'public_vision')
