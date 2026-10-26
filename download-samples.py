"""一次性资源准备脚本；日常启动不需要网络或 Python。"""
from pathlib import Path
from urllib.request import urlopen
from concurrent.futures import ThreadPoolExecutor

BASE = 'https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/master/'
ROOT = Path(__file__).resolve().parent
NOTES = {48: 'C3', 60: 'C4', 64: 'E4', 67: 'G4', 72: 'C5'}

def download(item):
    instrument, midi, filename = item
    remote = 'piano' if instrument == 'piano' else 'guitar-nylon'
    target = ROOT / 'samples' / instrument / f'{midi}.mp3'
    target.parent.mkdir(parents=True, exist_ok=True)
    with urlopen(f'{BASE}samples/{remote}/{filename}.mp3', timeout=40) as response:
        data = response.read()
    target.write_bytes(data)
    return f'{instrument}/{midi}.mp3: {len(data)} bytes'

if __name__ == '__main__':
    jobs = [('piano', midi, name) for midi, name in NOTES.items()]
    jobs += [('guitar', midi, name) for midi, name in
             {52: 'E3', 55: 'G3', 61: 'Cs4', 64: 'E4', 73: 'Cs5'}.items()]
    for result in ThreadPoolExecutor(max_workers=4).map(download, jobs):
        print(result)
    with urlopen(BASE + 'LICENSE.md', timeout=30) as response:
        (ROOT / 'samples' / 'LICENSE.md').write_bytes(response.read())
