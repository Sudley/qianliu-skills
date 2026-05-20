---
name: qianliu-aitest-local
description: 本地AI自动化测试调度工具，通过千流灵测客户端服务执行测试用例。支持：自定义/默认/引导多模式调度、xlsx/json/markdown用例解析与编写、并发任务执行与实时进度监控、执行日志持久化、Markdown测试报告生成。触发关键字：本地AI测试、本地自动化测试、本地回归测试、本地测试调度、生成本地灵测测试报告、查看本地灵测测试报告、帮我写本地灵测测试用例、编写本地灵测markdown用例。
version: 1.1.0
---

# 本地AI自动化测试工具

基于本地千流灵测客户端HTTP服务，从测试用例文件（xlsx / json / markdown）解析测试用例并并发调度执行，支持实时状态轮询和日志持久化。

## 能力概览

| 能力 | 说明 | 触发示例 |
|:---|:---|:---|
| 1. 默认调度执行（模式询问） | 健康检查后弹出模式选择（Demo / 自定义 / 默认 / 引导配置），按选择执行 | `/qianliu-aitest-local`、`本地AI测试`、`本地回归测试` |
| 2. 自定义快速模式 | 直接触发：传入用例文件路径（+ 可选知识库/并发数），全自动执行 | `/qianliu-aitest-local /path/to/cases.md`、`本地AI测试 /path/to/cases.xlsx --concurrency 3` |
| 3. 默认快速模式 | 直接触发：复用历史配置执行（仅当历史配置存在时有效） | `/qianliu-aitest-local --reuse`、`本地AI测试 --reuse` |
| 4. 指定任务调度执行 | 直接传入任务目录路径，跳过配置步骤，仅健康检查后立即后台执行 | `/qianliu-aitest-local --task-dir {path}`、`执行任务目录 {path}` |
| 5. 生成测试报告 | 传入 run_case_status.json 路径，立即生成 Markdown 报告 | `/qianliu-aitest-local --report {path}`、`生成测试报告 {path}` |
| 6. 编写测试用例文件 | 参照 assets 示例与格式规范，收集用户测试需求，生成规范 MD 用例文件 | `帮我写测试用例`、`生成 testcase.md`、`编写 markdown 用例到 {path}` |

---


**任务目录** = `{当前工作目录}/.qianliu/.qianliu-aitest-local/`

## 本地客户端服务启动校验（必须）

执行健康检查脚本：

```bash
node <skill目录>/scripts/health_check.js --port 8123
```

**处理逻辑：**

- **成功（exit code 0）**：脚本自动将 `port` 和 `client_id` 写入 `aitest-local-config.yaml`，继续下一步
- **失败（exit code 1）**：尝试读取`aitest-local-config.yaml`是否存在 port，执行一次重试。若重试仍然失败，则向用户提示需要安装并启动千流灵测客户端
  - 客户端安装与启动脚本地址（第一次安装需要等待较长时间）：http://chatgpt.sangfor.com/e2eplugin/update/main/install/prod_v2/install.exe
  - 若用户表示已启动服务，可能是端口不同，需要询问用户实际端口号
  - 使用用户提供的端口重新执行：`node <skill目录>/scripts/health_check.js --port {用户端口}`

> **Node.js 环境依赖**：若测试用例涉及浏览器操作（如 Web 页面自动化），客户端需依赖 **Node.js >= 22** 环境。请提前安装：[node-v22.14.0-x64.msi](https://nodejs.org/dist/v22.22.3/node-v22.22.3-x64.msi)

> 配置文件路径：`{任务目录}/aitest-local-config.yaml`
> 参考 `<skill目录>/assets/example/aitest-local-config.example.yaml`

---

## 一、前置环境配置（引导检查）

### 模式询问

健康检查通过后，**先执行前置检测**，再询问用户执行模式。

#### 前置检测

检查 `{任务目录}/aitest-local-config.yaml` 是否存在，且包含完整必填字段：`port`、`client_id`、`testcase_type`、`testcase_path`、`concurrency`。

- 检测结果存为 `has_history_config = true/false`
- 若 `has_history_config = true`，记录历史配置摘要（用例路径、类型、并发数），用于后续展示

#### 模式选择

通过 AskUserQuestion 询问用户：

> 请选择执行模式：
> - **[A] Demo 快速模式** — 使用内置 Demo 用例一键验证客户端，无需任何配置
> - **[B] 自定义快速模式** — 直接传入用例文件路径（+ 可选知识库/并发数），全自动执行
> - **[C] 默认快速模式** — 复用历史配置直接执行（`has_history_config=true` 时可选）
> - **[D] 引导配置模式** — 逐步向导，从头初始化所有配置

- 若 `has_history_config = false`，选项 [C] 标注为"（未检测到历史配置，不可用）"

---

#### [A] Demo 快速模式（全自动，无需交互）

一次性写入全部配置（使用 skill 目录下的 demo 资产文件）：

```bash
node <skill目录>/scripts/update_config.js \
  --config "{任务目录}/aitest-local-config.yaml" \
  --testcase-type markdown \
  --testcase-path "<skill目录>/assets/demo/testcase-demo.md" \
  --knowledge-path "<skill目录>/assets/demo/knowledge-demo.yaml" \
  --concurrency 1
```

直接创建任务目录（跳过 1.1～1.5 所有配置步骤）：

```bash
node <skill目录>/scripts/create_task.js \
  --config "{任务目录}/aitest-local-config.yaml"
```

创建完成后向用户展示提示：

```
配置完成，当前使用 Demo 用例展示自动化测试流程。

如需准备自己的测试用例 和 测试知识库（测试床），可参照：
  - 用例编写规范：<skill目录>/assets/testcase-guide.md
  - 用例格式示例：<skill目录>/assets/example/testcase.example.md
  - 测试知识库（测试床）示例：  <skill目录>/assets/demo/knowledge-demo.yaml
```

随后直接进入 **2.1 后台运行任务**。

---

#### [B] 自定义快速模式（全自动，无需交互）

**参数收集**（若触发消息中已提供则跳过询问）：

| 参数 | 必填 | 说明 |
|:---|:---|:---|
| 用例文件路径 | **是** | 自动从扩展名推断类型（.xlsx → xlsx / .json → json / .md → markdown） |
| 知识库 yaml 路径 | 否 | 可选，不传则不配置 |
| 并发数 | 否 | 默认 3 |

若触发消息中未提供用例文件路径，通过 AskUserQuestion 一次性询问上述三项。

收到参数后，依次执行：

```bash
# 1. 写配置
node <skill目录>/scripts/update_config.js \
  --config "{任务目录}/aitest-local-config.yaml" \
  --testcase-type {推断类型} \
  --testcase-path "{用户提供的路径}" \
  [--knowledge-path "{用户提供的路径}"] \
  --concurrency {并发数}

# 2. 预解析验证
node <skill目录>/scripts/parse_testcases.js \
  --config "{任务目录}/aitest-local-config.yaml"

# 3. 创建任务目录
node <skill目录>/scripts/create_task.js \
  --config "{任务目录}/aitest-local-config.yaml"
```

- 若预解析失败（用例文件不存在或格式错误），向用户报告错误原因，不继续执行
- 全部成功后直接进入 **2.1 后台运行任务**

---

#### [C] 默认快速模式（全自动，无需交互）

条件：`has_history_config = true`

向用户展示历史配置摘要（用例路径、类型、并发数），直接执行：

```bash
node <skill目录>/scripts/create_task.js \
  --config "{任务目录}/aitest-local-config.yaml"
```

- 若 `create_task.js` 报错（如用例文件不存在），提示错误原因，并建议切换到 [D] 引导配置模式
- 成功后直接进入 **2.1 后台运行任务**

---

#### [D] 引导配置模式

继续下方 1.1～1.5 步骤。

---

### 1.1 测试用例配置

检查 `aitest-local-config.yaml` 中是否存在 `testcase_path` 值：

**若已存在**：通过 AskUserQuestion 询问用户：
1. 复用原配置测试用例（继续使用已有路径，跳过后续选择步骤）
2. 运行新测试用例（继续配置新用例）

**若不存在，或用户选择运行新测试用例**：

> 各格式详细说明 参考 `<skill目录>/assets/testcase-guide.md`

提示用户贴入用例文件路径（根据类型提示对应扩展名：xlsx → `.xlsx`，json → `.json`，markdown → `.md`），将类型和路径一次写入配置：
   ```bash
   node <skill目录>/scripts/update_config.js \
     --config "{任务目录}/aitest-local-config.yaml" \
     --testcase-type {用户选择的类型} \
     --testcase-path "{用户贴入的路径}"
   ```

---

### 1.2 用例预解析

执行解析脚本（仅解析用例，不写配置，不创建任务目录）：

```bash
node <skill目录>/scripts/parse_testcases.js \
  --config "{任务目录}/aitest-local-config.yaml"
```

脚本会：
1. 验证用例文件存在并可解析（支持 xlsx / json / markdown）
2. 输出有效用例数

---

### 1.3 并发数配置

**默认使用并发数 3，无需询问用户。**

若用户主动要求修改并发数（如"并发数改为1"、"串行执行"），通过以下命令调整：

```bash
node <skill目录>/scripts/update_config.js \
  --config "{任务目录}/aitest-local-config.yaml" \
  --concurrency {用户指定的并发数}
```

> 并发数范围为 1-5。脚本 `run_local_tasks.js` 的代码默认值为 3，即使用户未显式配置也生效。

---

### 1.4 测试知识库配置

> 该知识库采用 Key-Value 结构的 YAML 格式定义，Agent 在执行测试任务期间会解析并加载该文件内容。

通过 AskUserQuestion 询问用户测试知识库配置方式：

- **手动输入测试知识库内容**（用户粘贴 YAML 格式内容）
- **指定测试知识库 yaml 文件路径**
- **使用默认测试知识库配置**（若 `aitest-local-config.yaml` 中已有 `knowledge_path`则提示）
- **无需配置**

**处理逻辑：**

**a) 手动输入：**
1. 提示用户粘贴 YAML 格式的测试知识库内容，例如：
   ```yaml
   base_url: "https://ainative.sangfor.com"
   ```
2. 将内容写入 `{任务目录}/aitest-knowledge.yaml`
3. 验证 YAML 格式是否正确；如有格式错误，提示用户并重新输入
4. 调用脚本将路径写入配置：
   ```bash
   node <skill目录>/scripts/update_config.js \
     --config "{任务目录}/aitest-local-config.yaml" \
     --knowledge-path "{任务目录}/aitest-knowledge.yaml"
   ```

**b) 指定文件路径：**
1. 用户提供 yaml 文件绝对路径
2. 验证文件存在且 YAML 格式正确；格式错误则提示用户修正
3. 调用脚本写入配置：
   ```bash
   node <skill目录>/scripts/update_config.js \
     --config "{任务目录}/aitest-local-config.yaml" \
     --knowledge-path "{用户提供路径}"
   ```

---

### 1.5 任务目录创建

前置配置全部完成后，创建任务目录并生成执行文件：

```bash
node <skill目录>/scripts/create_task.js \
  --config "{任务目录}/aitest-local-config.yaml"
```

脚本会：
1. 计算配置 hash（配置文件中所有字段，按 key 排序后 MD5 前 8 位）
2. 创建 `local_tasks/task_{YYYYMMDD}_{HHmmss}_{8位hash}/` 任务目录
3. 复制配置为 `task_config.yaml`
4. 解析 xlsx 并写入 `testcase.json`（英文 key 的 JSON 格式）
5. 输出有效用例数和任务目录路径

---

## 二、调度执行

### ⚠️ 操作约束

- 执行前须确保本地客户端服务已启动（健康检查通过）
- 执行过程中 Agent 不干预，仅在后台监控

### 快速入口：直接传递任务目录

当用户直接提供任务目录路径（如 `local_tasks/task_{date}_{time}_{md5}` 的完整路径）时，跳过步骤 1.2～1.5，直接进入 2.1 执行。仅须先完成 1.1 健康检查。

### 2.1 后台运行任务

从步骤 1.5 输出或用户直接提供的任务目录路径，**立即**在后台启动执行：

```bash
node <skill目录>/scripts/run_local_tasks.js \
  --task-dir "{local_tasks/task_{date}_{time}_{md5} 的完整路径}"
```

> **Agent 执行注意**：必须使用后台执行模式（`run_in_background: true`），不阻塞主流程。

启动后提示用户：
```
任务已在后台启动，共 {N} 个用例，并发数 {M}。
当前任务目录：{task_dir}
可打开 http://localhost:{port}/dashboard/#ai-test 查看可视化日志。
执行完成后将自动通知结果。
```

### 2.2 结果报告

后台任务完成后，Agent 解析输出的 JSON 汇总信息，向用户报告：

- 总用例数、成功数、失败数、中断数
- 执行总耗时
- 测试报告文件路径（`report_file`，任务目录下的 `test_report_{date}_{datetime}.md`）
- 状态文件路径（`run_case_status.json`）
- 日志目录路径
- 可视化面板地址

---

## 三、手动生成测试报告

当用户传入 `run_case_status.json` 路径（或任务目录路径）时，直接生成报告：

```bash
node <skill目录>/scripts/generate_report.js \
  --status-file "{run_case_status.json 的完整路径}"
```

脚本会在 `run_case_status.json` **同级目录**下生成 `test_report_{YYYYMMDD}_{HHmmss}.md`，并将文件路径输出到 stdout。

向用户报告报告文件路径，提示可直接打开查看。

## 四、编写测试用例文件（Markdown 格式）

参照 assets 中的示例与格式规范，根据用户描述的测试场景，生成符合本工具要求的 Markdown 用例文件。

### 参考文件

- **格式示例**：`<skill目录>/assets/example/testcase.example.md`（完整的 5 个示例用例，覆盖多种编号风格）
- **格式规范**：`<skill目录>/assets/testcase-guide.md`（章节结构、编号规则、Prompt 转换逻辑）

### 编写流程

**Step 1：收集测试需求**

通过 AskUserQuestion 询问用户：
- 需要测试的功能模块和业务场景（例如：登录、数据资产新建、文件上传）
- 各场景的关键操作路径

**Step 2：生成用例内容**

参照 `assets/example/testcase.example.md` 格式编写用例：
- 每个用例以 `## 用例标题` 开头
- 必须包含 `### 操作步骤`
- `### 期望结果` 按需添加（如果用户描述了期望行为则写，否则可不写）
- `### 前置条件` 和 `### 后置条件` **仅在用户明确要求时才添加**，不要主动生成
- 步骤使用统一编号格式（推荐 `1.` 英文点格式）
- 多个用例之间用 `---` 分隔

**Step 3：确认输出路径**

- **默认路径**：`{任务目录}/testcases.md`（任务目录 = `{cwd}/.qianliu/.qianliu-aitest-local/`）
- **用户指定路径**：若用户在触发时已提供路径（如"编写测试用例到 {path}"），则输出到指定位置

将生成的用例内容写入目标文件。

**Step 4：完成提示**

文件写入后向用户确认：
```
测试用例文件已生成：{输出路径}
共 {N} 个用例。

如需立即执行，可进入调度流程（能力 1），选择 markdown 格式，
用例文件路径填写：{输出路径}
```

---

## 速查表

### health_check.js — 服务健康检查

| 参数 | 必填 | 默认值 | 说明 |
|:---|:---|:---|:---|
| `--port` | 否 | 8123 | 本地服务端口 |
| `--config-dir` | 否 | `{cwd}/.qianliu/.qianliu-aitest-local/` | 配置文件目录 |

### parse_testcases.js — 用例预解析

| 参数 | 必填 | 说明 |
|:---|:---|:---|
| `--config` | **是** | 配置文件路径（`aitest-local-config.yaml`） |

### update_config.js — 配置追加

| 参数 | 必填 | 说明 |
|:---|:---|:---|
| `--config` | **是** | 配置文件路径（`aitest-local-config.yaml`） |
| `--concurrency` | 否 | 并发数（1-3），写入 `concurrency` 字段 |
| `--testcase-type` | 否 | 用例格式（xlsx/json/markdown），写入 `testcase_type` 字段 |
| `--testcase-path` | 否 | 用例文件路径，写入 `testcase_path` 字段 |
| `--knowledge-path` | 否 | 测试知识库 yaml 路径，写入 `knowledge_path` 字段 |

### create_task.js — 任务目录创建

| 参数 | 必填 | 说明 |
|:---|:---|:---|
| `--config` | **是** | 配置文件路径（须已含 port、client_id、testcase_path、concurrency）；若含 knowledge_path，自动将测试知识库文件复制到任务目录 |

### run_local_tasks.js — 并发执行编排器

| 参数 | 必填 | 说明 |
|:---|:---|:---|
| `--task-dir` | **是** | 任务目录路径（`local_tasks/task_{date}_{time}_{md5}`）；若目录下存在 `aitest-knowledge.yaml`，将其内容作为 `task_config` 传入 API |

### generate_report.js — 测试报告生成

| 参数 | 必填 | 说明 |
|:---|:---|:---|
| `--status-file` | **是** | `run_case_status.json` 的完整路径；报告输出到同级目录，命名为 `test_report_{YYYYMMDD}_{HHmmss}.md` |

---

## 目录结构

> 详细说明参考 `<skill目录>/references/task-directory-structure.md`

```
.qianliu/
└── .qianliu-aitest-local/
    ├── aitest-local-config.yaml
    └── local_tasks/
        └── task_{date}_{time}_{md5}/
            ├── task_config.yaml
            ├── testcase.json
            ├── run_case_status.json
            ├── test_report_{date}_{datetime}.md
            └── run_log_{timestamp}/
                └── {case_id}_{case_name}.log
```
