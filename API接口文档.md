# 随音 API 接口文档 v1（课程交付）

**基础地址：** `http://127.0.0.1:5173`；仅本机访问。除音频上传外，请发送 `Content-Type: application/json`。所有 HTTP 返回 JSON。**不支持登录、token、CORS 公网服务**。

## A. 总览

| 方法 | 路径 | 输入/返回 | 状态 |
|---|---|---|---|
| GET | `/api/health` | `ok`、运行时间、曲谱数、报告数、队列统计 | 已实现 |
| GET | `/api/scores` | `scores[]`：曲谱摘要 | 已实现 |
| POST | `/api/scores` | `{score}` → 已登记曲谱摘要 | 已实现、写入 JSON 文件 |
| POST | `/api/sessions` | `{scoreId,options}` 或 `{score,options}` → `sessionId` 等 | 已实现 |
| GET | `/api/sessions/{id}` | 当前谱位、统计、目标音、判定 | 已实现，活动会话在内存 |
| POST | `/api/sessions/{id}/events` | 按键事件 → `judgements`、`report` | 已实现 |
| POST | `/api/sessions/{id}/tick` | `{timestamp}` → 进度和漏音判定 | 已实现 |
| POST | `/api/sessions/{id}/finish` | `{timestamp}` → 最终统计，并保存报告 | 已实现、写入 JSON 文件 |
| DELETE | `/api/sessions/{id}` | 删除内存会话 | 已实现 |
| POST | `/api/match` | 批量音高时间序列 → 简单规则对齐结果 | 已实现，不是 DTW/HMM |
| GET | `/api/reports` | 已结束练习报告摘要 | 已实现、文件持久化 |
| GET | `/api/reports/{id}` | 某个会话已落盘的完整报告 | 已实现、文件持久化 |
| GET | `/api/model/health` | 检查 Python 模型联通性 | 已实现、取决于模型是否启动 |
| POST | `/api/transcriptions` | 原始 WAV bytes → Basic Pitch 模型转录结果 | 已实现代理、需部署 Python |
| POST | `/api/jobs/transcriptions` | 原始 WAV bytes → `202 {jobId,poll}` | 已实现异步任务入队 |
| GET | `/api/jobs/{id}` | 任务状态、耗时、结果或错误 | 已实现 |
| GET | `/api/jobs` | 内存队列的等待/正在运行/已保留任务数量 | 已实现 |

## B. 数据结构与例子

### 1. 注册曲谱 — POST `/api/scores`

```json
{
  "score": {
    "id": "my-melody",
    "title": "自定义音阶",
    "bpm": 80,
    "measures": 1,
    "events": [
      {"id": "n1", "pitches": [60], "beat": 0, "duration": 1, "measure": 1},
      {"id": "n2", "pitches": [62], "beat": 1, "duration": 1, "measure": 1}
    ]
  }
}
```

返回 HTTP 201：`{"score":{"id":"my-melody","title":"自定义音阶","bpm":80,"measures":1,"events":2},"persisted":true}`。此处是**规范化曲谱 JSON**，不是直接上传 MusicXML；MusicXML 解析仍在浏览器端。

### 2. 创建练习 — POST `/api/sessions`

```json
{"scoreId":"scale","options":{"mode":"wait","bpm":72,"tolerance":250,"chordWindow":160}}
```

返回 HTTP 201，字段包含 `sessionId`（UUID）、`status:"active"`、`index`、`eventId`、`nextPitches`、`report`、`options`。支持 `mode` 为 `wait`（等待正确音）或 `follow`（时序跟随）。

### 3. 按键上报 — POST `/api/sessions/{id}/events`

```json
{"sequence":1,"type":"note_on","pitch":60,"timestamp":100,"velocity":0.8,"source":"keyboard"}
```

`pitch` 为 MIDI 0~127，`timestamp` 是从练习开始计的**有效毫秒时钟**（不是 Unix 时间戳），`sequence` 从 1 递增。`type` 为 `note_on`/`note_off`；速度可省略，范围 0~1。返回 HTTP 200：

```json
{
  "sessionId":"<本次实际 UUID>",
  "sequence":1,
  "index":1,
  "eventId":"scale-2",
  "nextPitches":[62],
  "judgements":[{"type":"correct"}],
  "report":{"correct":1,"judged":1,"accuracy":100},
  "processingMs":0.3
}
```

> 上面是**结构演示**，只摘录实际响应的关键字段；完整返回还包括错误、历史判定、进度等，`processingMs` 是示意值而非保证值。服务器重复接到同一 `sequence` 时返回 `duplicate:true`；乱序返回 HTTP 409 `SEQUENCE_ERROR`。

### 4. 结束并存储报告 — POST `/api/sessions/{id}/finish`

```json
{"timestamp":1500}
```

返回 `status:"finished"`、最终 `report`。重启 Node 后仍可用 `GET /api/reports/{id}` 查询。**只有结束后的报告会持久化**，活动会话和 MIDI 原始事件日志尚未落盘。

### 5. 批量规则匹配 — POST `/api/match`

```json
{
  "scoreId":"scale",
  "options":{"mode":"follow","bpm":72},
  "notes":[{"pitch":60,"startMs":0},{"pitch":62,"startMs":850}],
  "endMs":1900
}
```

返回 `judgements[]`、`index`、`done`、`report`、`processingMs`。使用现有 `PracticeEngine` 规则判定。**不可以将此接口描述成神经网络对齐、DTW 或 HMM。**

### 6. 同步音频转录 — POST `/api/transcriptions`

**Content-Type：** `audio/wav`，请求体为原始 WAV 二进制，最大 5 MiB、需有 RIFF/WAVE 文件头。需要先启动 Python Basic Pitch 服务。典型 HTTP 200：

```json
{
  "model":"Spotify Basic Pitch",
  "noteCount":2,
  "notes":[
    {"pitch":60,"startMs":50,"endMs":600,"confidence":0.72},
    {"pitch":64,"startMs":720,"endMs":1250,"confidence":0.69}
  ],
  "inferenceMs":320.1,
  "totalModelServiceMs":334.2,
  "roundTripMs":344.4
}
```

> **以上数值和音符只是响应格式的示例，并非真实测试结果。** 在汇报中应使用模型实际调用所得输出。

### 7. 异步任务队列 — POST `/api/jobs/transcriptions`

同样上传原始 WAV。成功 HTTP 202：

```json
{"jobId":"<UUID>","status":"queued","createdAt":"2026-10-22T00:00:00.000Z","poll":"/api/jobs/<UUID>"}
```

轮询 `GET /api/jobs/{id}`，可得到 `queued`、`running`、`completed` 或 `failed`：

```json
{
  "jobId":"<UUID>",
  "status":"completed",
  "createdAt":"...",
  "startedAt":"...",
  "finishedAt":"...",
  "queueWaitMs":13,
  "executionMs":350.2,
  "result":{"model":"Spotify Basic Pitch","noteCount":2,"notes":[],"inferenceMs":340}
}
```

> 此处结构为**说明性示例**。完成后 `result` 来自真实模型；模型离线时 `failed` 并返回 `error.code="MODEL_JOB_FAILED"`。队列最大 3 个**等待项**、单个工作执行者、任务结果完成后在内存保留约 30 分钟，不进行持久化。

## C. 错误约定

格式：`{"code":"SOME_CODE","message":"中文原因"}`（部分由独立模型上游返回的错误只有 `message`）。

| HTTP | 代码示例 | 含义 |
|---|---|---|
| 400 | `INVALID_JSON` | JSON 解析失败 |
| 404 | `SCORE_NOT_FOUND`、`SESSION_NOT_FOUND`、`REPORT_NOT_FOUND`、`JOB_NOT_FOUND` | 不存在 |
| 409 | `SEQUENCE_ERROR`、`TIME_REVERSED`、`SESSION_FINISHED`、`SCORE_EXISTS` | 状态冲突 |
| 413 | `TOO_LARGE` | 上传体太大 |
| 415 | `JSON_REQUIRED`、`WAV_REQUIRED` | Content-Type 错误 |
| 422 | `INVALID_SCORE`、`INVALID_EVENT`、`INVALID_WAV` | 参数或格式错误 |
| 429 | `SCORE_LIMIT`、`JOB_QUEUE_FULL` | 容量上限 |
| 503 | `MODEL_UNAVAILABLE` | Python 模型未启动或服务超时 |
| 500 | `INTERNAL` | 服务端异常，请查后端终端日志 |

## D. PowerShell 快速调用（可做课程现场演示）

```powershell
# 1. 查看 Node 服务状态
Invoke-RestMethod http://127.0.0.1:5173/api/health

# 2. 查看内置乐谱
Invoke-RestMethod http://127.0.0.1:5173/api/scores

# 3. 新建练习并上报 C4
$s = Invoke-RestMethod http://127.0.0.1:5173/api/sessions -Method Post -ContentType 'application/json' -Body '{"scoreId":"scale"}'
Invoke-RestMethod "http://127.0.0.1:5173/api/sessions/$($s.sessionId)/events" -Method Post -ContentType 'application/json' -Body '{"sequence":1,"type":"note_on","pitch":60,"timestamp":100}'

# 4. 结束练习并验证本地持久化
Invoke-RestMethod "http://127.0.0.1:5173/api/sessions/$($s.sessionId)/finish" -Method Post -ContentType 'application/json' -Body '{"timestamp":200}'
Invoke-RestMethod "http://127.0.0.1:5173/api/reports/$($s.sessionId)"

# 5. Python 模型部署成功后再执行
Invoke-RestMethod http://127.0.0.1:5173/api/model/health
```

## E. 实现限制

- 规则乐谱匹配不是深度学习音频转录：`/api/match` 与 `/api/transcriptions` 是不同能力。
- 文件存储为本机 JSON 记录；不是 PostgreSQL/MySQL；**活动会话和任务结果不会重启恢复**。
- Python 模型是独立本地服务，Node `/api/transcriptions` 只做代理；未安装模型时按键服务独立可用。
- 无身份认证，不应作为公网生产 API 开放；HTTPS、用户隔离、生产日志/监控/数据库迁移属于后续工作。
