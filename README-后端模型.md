# 随音 · 后端接口与音频模型联调说明

> 适用于 Windows 10 / 11，Node.js 18+（Node 24 也可以），**只启动 Node 就能使用全部原有乐器练习功能和新增按键服务**。模型转录属于独立可选的 Python 服务，首次安装需联网，当前不支持实时麦克风流。此文件是实际实现说明，而不是未来接口草案。

**课程交付请优先阅读**：[`课程交付-部署与模型调用.md`](课程交付-部署与模型调用.md)、[`API接口文档.md`](API接口文档.md)、[`课程汇报-后端技术与答辩稿.md`](课程汇报-后端技术与答辩稿.md)。这三份包含本地 JSON 持久化与异步任务队列的新增说明；本文件为原有版本的联调补充说明。

## 一、先启动（不需要 VS Code）

1. 将 ZIP 解压到电脑的普通文件夹。进入 `项目工程` 文件夹。
2. **双击 `启动随音.bat`**，保持黑色终端窗口打开。
3. 打开浏览器访问 http://localhost:5173 。
4. 在浏览器里打开 http://localhost:5173/api/health ，应看到 JSON 里的 `"ok":true`。
5. 在网页的钢琴上选择《小星星》，开始练习。右侧「后端与模型」卡片会显示「Node API 已连接 · 双端判定对照中」；真实发声、琴键提示、即时评分依旧留在本地，后端将同一组按键事件再计算一遍，用于服务化联调和报告对照。

Node.js 命令行启动方式（PowerShell）：

```powershell
cd "你的工程文件夹路径\项目工程"
node server.cjs
```

PowerShell 里的 `npm` 如果被脚本策略禁止，请使用 `npm.cmd`。此项目**启动不需要运行 `npm install`**。

## 二、服务架构

```text
网页浏览器（已有的演奏、乐谱、提示、报告）
  ├─ 本地 Web Audio 发声 + PracticeEngine 毫秒级响应
  ├─ src/backend-client.mjs 异步旁路同步 note_on / note_off / tick
  │        │
  │        ▼
  │  Node.js http://127.0.0.1:5173  （server.cjs）
  │        ├─ backend/api.mjs
  │        │    ├─ 规范化曲谱校验与乐谱库 API
  │        │    ├─ PracticeEngine 会话化 / 错漏音判定 / 报告
  │        │    └─ 离线音符序列对齐 /api/match
  │        └─ /api/transcriptions ←代理→ Python http://127.0.0.1:8765
  │                                         └─ Spotify Basic Pitch 真实 ML 模型
  └─ <选择 WAV 文件> -> 转录音高时间戳 -> 曲谱粗对齐
```

**重要边界：** 目前前端显示以本地规则引擎为主，服务端作为*旁路验证*；不是完全由后端控制光标的权威模式。Node 服务复用 `src/engine.mjs`，因此算法与判定口径一致。活动会话仍只保存在 Node 进程内存中；但新增曲谱与调用 `/finish` 后的报告现在存入 `data/backend-records.json`，服务重启仍可访问；浏览器练习历史另外保存在 localStorage。没有用户账号、关系型数据库、鉴权或互联网公网发布功能，只监听 `127.0.0.1`。

### 核心接口

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/health` | Node 健康检查 |
| GET | `/api/scores` | 列出内存中的规范化曲谱摘要 |
| POST | `/api/scores` | 注册规范化 `score` JSON（与前端曲谱字段相同） |
| POST | `/api/sessions` | 建立会话，指定 `scoreId` 或完整 `score`、`options` |
| POST | `/api/sessions/{id}/events` | 传入**单个**按键事件，验证自增序号、练习时间和音高 |
| POST | `/api/sessions/{id}/tick` | 跟弹时间推进，触发超时漏音 |
| GET | `/api/sessions/{id}` | 查询最新位置、错误、判定和阶段报告 |
| POST | `/api/sessions/{id}/finish` | 结束会话并返回报告，不自动把未来音符算漏音 |
| DELETE | `/api/sessions/{id}` | 删除会话 |
| POST | `/api/match` | 输入音符时间序列与曲谱做离线规则匹配 |
| GET | `/api/model/health` | 检查独立模型服务是否在线 |
| POST | `/api/transcriptions` | 上传 `audio/wav` 原始 WAV，返回预测音符序列与推理耗时 |

**请求示例**：可使用 PowerShell（窗口在项目目录运行）。

```powershell
# 建立一场等待模式练习（返回 sessionId）
$session = Invoke-RestMethod -Uri http://localhost:5173/api/sessions -Method Post -ContentType 'application/json' -Body '{"scoreId":"scale","options":{"mode":"wait","bpm":72}}'
$session.sessionId

# 按下 MIDI 60，即 C4；毫秒时间轴从 0 开始，sequence 从 1 开始
$body = '{"sequence":1,"type":"note_on","pitch":60,"velocity":0.8,"timestamp":100,"source":"keyboard"}'
$result = Invoke-RestMethod -Uri "http://localhost:5173/api/sessions/$($session.sessionId)/events" -Method Post -ContentType 'application/json' -Body $body
$result.judgements
$result.eventId
$result.report.accuracy
```

返回包含 `sessionId`、`sequence`、`eventId`、`measure`、`nextPitches`、`judgements`、`errors`、`report`、`processingMs`。按键 `note_on` 会计分，`note_off` 不计分；同一个 sequence 重复上送返回已缓存结果；乱序、回退时间或非法音高返回 4xx 和错误码。时间戳采用用户练习的有效毫秒时间轴，排除暂停与预备拍；它并非服务端绝对时钟。

### 离线音符匹配示例

```json
{
  "scoreId": "scale",
  "options": {"mode": "follow", "bpm": 72},
  "notes": [
    {"pitch": 60, "startMs": 0},
    {"pitch": 62, "startMs": 850},
    {"pitch": 64, "startMs": 1670}
  ],
  "endMs": 2200
}
```

使用 `POST /api/match`。这里是**原本的简单规则跟随**，不是 Matchmaker 的 HMM/DTW；对于跳奏、自由速度和长音多声部，结果可能不准确。

## 三、音频转录模型安装（可选，但课程“模型部署”需要）

采用 **Spotify Basic Pitch**：真实的音频→复音 MIDI 音符预测模型，由 Python 在单独进程加载一次、复用推理。模型来源：<https://github.com/spotify/basic-pitch> （Apache-2.0）。

在 Windows 上建议安装 **Python 3.10（64 位）**，选中安装程序里的 “Add Python to PATH”，也可使用 py launcher。然后打开 PowerShell，定位到解压后的 `项目工程` 文件夹：

```powershell
py -3.10 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r model\requirements.txt
.\.venv\Scripts\python.exe model\model_server.py
```

保持这个 Python 窗口运行，再**另开 PowerShell** 并启动 `node server.cjs`（或者双击 `启动随音.bat`）。

检查 http://localhost:5173/api/model/health ，若 `connected:true` 说明 Python 模型已连接。然后在网页右侧「后端与模型」区域，选择本项目自带的 `合成示例-C4_E4.wav`（也可使用自己录制的 WAV）→ 点击「音频转录与乐谱对照」，查看每个预测音高、起奏秒数、推理耗时，以及与当前乐谱的规则匹配结果。

也可以**双击 `启动音频模型.bat`**：若已经创建 `.venv`，批处理将优先使用 `.venv`。如果看到 `ModuleNotFoundError: basic_pitch`，说明还没有正确安装模型依赖。

**注意：** WAV 批量转录不等于实时麦克风跟随。模型常用于录制片段离线转录；运行模型需要 Python/ONNX Runtime、内存和首次下载安装的模型权重。此工程不把模型输出混入按键练习的原始报告，以免重复计分。对人声、噪声、录音设备、复音吉他等场景，准确率未做保证。项目中提供的音频只是**合成测试信号**，并不等于真实演奏验证。

## 四、延迟测试与数据口径

在项目根目录执行：

```powershell
npm.cmd test
npm.cmd run benchmark
# 安装并启动 Python 模型后，再运行包含推理的测试：
npm.cmd run benchmark -- --with-model
```

实测结果写入 `benchmarks/last-run.json`：包含 Node 版本、操作系统、原始请求 100 次（前 10 次预热）的平均、P50/P95/P99 等。**API `requestRoundTrip`** 是 HTTP 请求发出到返回 JSON 的耗时；**`serverProcessing`** 是服务端解析、规则判定到组装结果的时间（不包含网络传输）。若启用模型：`modelInferenceMs` 是模型推理阶段耗时，`completeHttpRoundTripMs` 是上传合成 WAV 到收到转录结果的全链路请求耗时，`realTimeFactor` 是模型推理耗时 / 音频时长。

`benchmarks/last-run.json` 是**执行脚本的那台电脑**的实际测量，不可直接声称是用户 Windows PC 的结果，也不是人体可感知的“琴键按下到扬声器出声”端到端音频时延。后者需额外用 MIDI 时间戳、回环声卡/麦克风、采样率与浏览器调度一起测量。

## 五、已知限制 / 下一步

- 真正的实时音频跟谱还未实现（缺少持续音频流分帧、模型推理队列、去抖/合帧、丢帧处理与在线谱位重定位）。
- 当前服务使用原有规则 `PracticeEngine`，没有部署 `pymatchmaker`；若课程要求专门部署该库，需要另建 Python 跟随服务，而不能把本服务说成 Matchmaker。项目地址：<https://github.com/pymatchmaker/matchmaker>。
- `node` 前端/后端是单进程内存演示：没有数据库、授权和公网隔离；请勿未经额外加固就开放互联网。
- Python Basic Pitch 需要在安装模型依赖的目标系统上实际验证。未安装模型时返回明确的 `MODEL_UNAVAILABLE`，不会生成假的音符结果或延迟数字。
