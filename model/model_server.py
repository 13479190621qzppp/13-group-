"""可选的真正 ML 模型服务：Spotify Basic Pitch，非规则伪转录。

使用 Python 3.10 / 3.11，安装 basic-pitch 后启动；默认只监听本机。
POST /transcribe Content-Type: audio/wav (最多 5 MiB) → MIDI 音符事件。
"""
import json
import os
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from basic_pitch import ICASSP_2022_MODEL_PATH
from basic_pitch.inference import Model, predict

MAX_AUDIO = 5 * 1024 * 1024
PORT = int(os.environ.get('MODEL_PORT', '8765'))

print('正在加载 Spotify Basic Pitch 模型（首次可能较慢）…', flush=True)
start = time.perf_counter()
model = Model(ICASSP_2022_MODEL_PATH)
print(f'Basic Pitch 模型已加载：{(time.perf_counter()-start)*1000:.1f} ms', flush=True)
lock = threading.Lock()  # 单个模型实例避免多个并发请求的推理竞争


class Handler(BaseHTTPRequestHandler):
    def respond(self, code, data):
        payload = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == '/health':
            self.respond(200, {'ok': True, 'model': 'Spotify Basic Pitch', 'runtime': str(ICASSP_2022_MODEL_PATH), 'ready': True})
        else:
            self.respond(404, {'message': 'Not found'})

    def do_POST(self):
        if self.path != '/transcribe':
            return self.respond(404, {'message': 'Not found'})
        if self.headers.get('Content-Type', '').split(';')[0].strip() != 'audio/wav':
            return self.respond(415, {'message': '只接受 audio/wav 音频'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return self.respond(400, {'message': 'Content-Length 无效'})
        if not (44 <= length <= MAX_AUDIO):
            return self.respond(413, {'message': 'WAV 大小应为 44 字节至 5 MiB'})
        wave = self.rfile.read(length)
        if wave[:4] != b'RIFF' or wave[8:12] != b'WAVE':
            return self.respond(422, {'message': '不是 RIFF/WAV 文件'})
        started = time.perf_counter()
        filepath = None
        try:
            # Windows 上须先关闭临时文件，否则模型无法再次打开。
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
                tmp.write(wave)
                filepath = tmp.name
            with lock:
                inference_start = time.perf_counter()
                _, _, note_events = predict(filepath, model)
                inference_ms = round((time.perf_counter() - inference_start) * 1000, 3)
            notes = sorted(({
                'pitch': int(pitch),
                'startMs': round(max(0.0, float(begin)) * 1000, 2),
                'endMs': round(float(end) * 1000, 2),
                'confidence': round(float(velocity), 4)
            } for begin, end, pitch, velocity, _ in note_events),
                key=lambda n: (n['startMs'], n['pitch']))
            self.respond(200, {
                'model': 'Spotify Basic Pitch',
                'noteCount': len(notes), 'notes': notes,
                'inferenceMs': inference_ms,
                'totalModelServiceMs': round((time.perf_counter()-started)*1000, 3)
            })
        except Exception as exc:
            # 返回短错误信息供本机调试，避免泄漏磁盘路径/内部堆栈。
            print(f'音频转录失败：{type(exc).__name__}: {exc}', flush=True)
            self.respond(500, {'message': '模型转录失败；请检查 WAV 格式、采样率和 Python 日志'})
        finally:
            if filepath:
                try: os.unlink(filepath)
                except OSError: pass


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'Basic Pitch 服务已启动：http://127.0.0.1:{PORT}/health', flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: print('模型服务已停止')
    finally: server.server_close()
