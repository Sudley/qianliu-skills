#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const yaml = require('./vendor/js-yaml');
const { createLocalClient } = require('./lib/http_client');

// ─── Constants ──────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 3000;       // 3 seconds between status polls
const CASE_TIMEOUT_MS = 7200000;      // 2 hours per case
const TERMINAL_STATES = ['success', 'fail', 'breakoff'];

// ─── Argument parsing ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { taskDir: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--task-dir' && argv[i + 1]) {
      args.taskDir = argv[i + 1];
      i++;
    }
  }
  return args;
}

// ─── Prompt construction ────────────────────────────────────────────────────

/**
 * Parse numbered steps from text.
 * Supports formats: 1、 1. 1） (1) 1)
 * Returns Map<number, string>
 */
function parseNumberedSteps(text) {
  if (!text || !text.trim()) return new Map();

  const steps = new Map();
  const lines = text.split(/\n/).map(l => l.trim()).filter(l => l);

  // Regex to match step number prefix
  const stepRegex = /^\s*(?:\()?(\d+)\s*[、.）)]\s*/;

  let currentNum = null;
  let currentText = '';

  for (const line of lines) {
    const match = line.match(stepRegex);
    if (match) {
      // Save previous step
      if (currentNum !== null) {
        steps.set(currentNum, currentText.trim());
      }
      currentNum = parseInt(match[1], 10);
      currentText = line.replace(stepRegex, '').trim();
    } else if (currentNum !== null) {
      // Continuation of previous step
      currentText += ' ' + line;
    }
  }

  // Save last step
  if (currentNum !== null) {
    steps.set(currentNum, currentText.trim());
  }

  return steps;
}

/**
 * Build the prompt by merging preconditions, steps, expected results, and postconditions.
 * Format: continuous numbering with [前置步骤], [期望结果], [后置步骤] tags
 * Example:
 *   1、[前置步骤] AAA
 *   2、[前置步骤] BBB
 *   3、CCC
 *   4、DDD [期望结果] DDD-expected
 *   5、[后置步骤] EEE
 *   6、[后置步骤] FFF
 */
function buildPrompt(testcase) {
  const preconditionsMap = parseNumberedSteps(testcase.preconditions);
  const stepsMap = parseNumberedSteps(testcase.steps);
  const expectedMap = parseNumberedSteps(testcase.expected_results);
  const postconditionsMap = parseNumberedSteps(testcase.postconditions);

  if (stepsMap.size === 0 && preconditionsMap.size === 0) {
    // Fallback: use raw concatenation for non-numbered format
    let prompt = '';
    if (testcase.preconditions) prompt += `预置条件: ${testcase.preconditions}\n`;
    if (testcase.steps) prompt += testcase.steps;
    if (testcase.expected_results) prompt += `\n期望结果: ${testcase.expected_results}`;
    if (testcase.postconditions) prompt += `\n后置条件: ${testcase.postconditions}`;
    return prompt.trim();
  }

  const lines = [];
  let stepIndex = 1;

  // 1. Add preconditions with [前置步骤] tag
  for (const [, text] of preconditionsMap) {
    lines.push(`${stepIndex}、[前置步骤] ${text}`);
    stepIndex++;
  }

  // 2. Add steps with expected results
  const allStepNums = [...new Set([...stepsMap.keys(), ...expectedMap.keys()])].sort((a, b) => a - b);
  for (const num of allStepNums) {
    const stepText = stepsMap.get(num);
    const expectedText = expectedMap.get(num);

    if (stepText && expectedText) {
      lines.push(`${stepIndex}、${stepText} [期望结果] ${expectedText}`);
    } else if (stepText) {
      lines.push(`${stepIndex}、${stepText}`);
    }
    stepIndex++;
  }

  // 3. Add postconditions with [后置步骤] tag
  for (const [, text] of postconditionsMap) {
    lines.push(`${stepIndex}、[后置步骤] ${text}`);
    stepIndex++;
  }

  return lines.join('\n');
}

// ─── Concurrency limiter ────────────────────────────────────────────────────

async function runWithConcurrency(taskFns, limit) {
  const results = [];
  const executing = new Set();

  for (const fn of taskFns) {
    const p = fn().then(r => { executing.delete(p); return r; });
    executing.add(p);
    results.push(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

// ─── Sleep helper ───────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Format timestamp ───────────────────────────────────────────────────────

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// ─── Save status file ───────────────────────────────────────────────────────

function saveStatusFile(statusFilePath, allStatus) {
  const summary = {
    updated_at: new Date().toISOString(),
    total: allStatus.length,
    success: allStatus.filter(s => s.status === 'success').length,
    fail: allStatus.filter(s => s.status === 'fail').length,
    breakoff: allStatus.filter(s => s.status === 'breakoff').length,
    pending: allStatus.filter(s => s.status === 'pending').length,
    running: allStatus.filter(s => s.status === 'running').length,
    cases: allStatus,
  };
  fs.writeFileSync(statusFilePath, JSON.stringify(summary, null, 2), 'utf8');
  return summary;
}

// ─── Execute single test case ───────────────────────────────────────────────

async function executeSingleCase(client, testcase, logDir, allStatus, statusFilePath, caseIndex, port, taskConfig, abortSignal, onProgress) {
  const caseId = testcase.case_id || `case_${caseIndex}`;
  const caseName = (testcase.case_title || 'unknown').replace(/[<>:"/\\|?*]/g, '_').substring(0, 50);
  const logFile = path.join(logDir, `${caseId}_${caseName}.log`);

  const statusEntry = allStatus[caseIndex];
  statusEntry.status = 'running';
  statusEntry.started_at = new Date().toISOString();
  saveStatusFile(statusFilePath, allStatus);
  if (onProgress) onProgress(caseIndex, 'running', testcase.case_title);

  const logLines = [];
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    logLines.push(line);
  };

  try {
    // Check if globally aborted before starting
    if (abortSignal.aborted) {
      log(`任务已被终止(${abortSignal.reason}), 跳过执行`);
      statusEntry.status = 'breakoff';
      statusEntry.error = abortSignal.reason;
      return statusEntry;
    }

    // 1. Build prompt
    const prompt = buildPrompt(testcase);
    statusEntry.prompt = prompt;
    log(`用例: ${caseId} - ${testcase.case_title}`);
    log(`Prompt:\n${prompt}`);

    // 2. Create task
    log('创建任务...');
    const createBody = { is_headless: false };
    if (taskConfig) createBody.task_config = taskConfig;
    const createRes = await client.post('/api/v1/aitest/tasks', createBody);
    const taskId = createRes.data.task_id || (createRes.data.data && createRes.data.data.task_id);
    if (!taskId) {
      throw new Error('创建任务失败: 未返回 task_id, response: ' + JSON.stringify(createRes.data));
    }
    log(`任务已创建: task_id=${taskId}`);
    statusEntry.task_id = taskId;
    statusEntry.dashboard_url = `http://localhost:${port}/dashboard/#ai-test/${taskId}`;

    // 3. Start task with prompt
    log('启动任务...');
    const runBody = { prompt, is_headless: false, is_task_info_parsed: true };
    if (taskConfig) runBody.task_config = taskConfig;
    await client.post(`/api/v1/aitest/tasks/${taskId}/run`, runBody);
    log('任务已启动');

    // 4. Poll for status
    const startTime = Date.now();
    let lastStatus = 'waiting';

    while (true) {
      await sleep(POLL_INTERVAL_MS);

      if (Date.now() - startTime > CASE_TIMEOUT_MS) {
        log(`单用例超时 (${CASE_TIMEOUT_MS / 1000}s), 终止所有任务`);
        abortSignal.aborted = true;
        abortSignal.reason = 'case_timeout';
        statusEntry.status = 'breakoff';
        statusEntry.error = 'timeout';
        break;
      }

      if (abortSignal.aborted) {
        log(`任务已被终止(${abortSignal.reason}), 标记 breakoff`);
        statusEntry.status = 'breakoff';
        statusEntry.error = abortSignal.reason;
        break;
      }

      try {
        const statusRes = await client.get(`/api/v1/aitest/tasks/${taskId}/status`);

        // Detect success: false response (e.g. task not found)
        if (statusRes.data.success === false) {
          const errMsg = statusRes.data.message || '未知服务端错误';
          log(`服务端返回失败: ${errMsg}`);
          statusEntry.status = 'fail';
          statusEntry.error = errMsg;
          break;
        }

        const status = statusRes.data.data ? statusRes.data.data.status : statusRes.data.status;

        if (status !== lastStatus) {
          log(`状态变更: ${lastStatus} -> ${status}`);
          lastStatus = status;
        }

        if (TERMINAL_STATES.includes(status)) {
          statusEntry.status = status;
          log(`用例执行完成: ${status}`);
          if (onProgress) onProgress(caseIndex, status, testcase.case_title);
          break;
        }
      } catch (pollErr) {
        log(`轮询出错: ${pollErr.message}`);
      }
    }

    // 5. Get execution messages
    try {
      const msgRes = await client.get(`/api/v1/aitest/tasks/${taskId}/messages`);
      const messages = msgRes.data.data ? msgRes.data.data.messages : (msgRes.data.messages || []);

      log(`\n--- 执行过程消息 (共 ${messages.length} 条) ---`);
      for (const msg of messages) {
        log(`[${msg.msg_type}] ${msg.content}`);
      }
      statusEntry.message_count = messages.length;

      // Parse assertion results from messages
      let lastAssertContent = null;
      let lastAssertIsSuccess = null;

      for (const msg of messages) {
        const content = msg.content || '';
        const successMatch = content.match(/√\s*断言成功[:：]\s*([\s\S]+)$/);
        const failMatch = content.match(/×\s*断言失败[:：]\s*([\s\S]+)$/);

        if (successMatch) {
          lastAssertContent = '√ 断言成功: ' + successMatch[1].trim();
          lastAssertIsSuccess = true;
        } else if (failMatch) {
          lastAssertContent = '× 断言失败: ' + failMatch[1].trim();
          lastAssertIsSuccess = false;
        }
      }

      if (lastAssertContent !== null) {
        statusEntry.assert_result = lastAssertContent;
        if (statusEntry.status === 'success' && !lastAssertIsSuccess) {
          log(`断言校验: 服务返回success，但最后一次断言失败，状态修正为fail`);
          statusEntry.status = 'fail';
        }
      }
    } catch (msgErr) {
      log(`获取消息失败: ${msgErr.message}`);
    }

    // 6. Archive task — release browser & MCP resources
    if (taskId) {
      try {
        await client.post(`/api/v1/aitest/tasks/${taskId}/archive`);
        log(`任务已归档: task_id=${taskId}`);
      } catch (archiveErr) {
        log(`归档任务失败(不阻塞): ${archiveErr.message}`);
      }
    }

  } catch (err) {
    log(`执行出错: ${err.message}`);
    statusEntry.status = statusEntry.status === 'running' ? 'fail' : statusEntry.status;
    statusEntry.error = err.message;
  }

  // Write log file
  statusEntry.finished_at = new Date().toISOString();
  statusEntry.log_file = logFile;
  fs.writeFileSync(logFile, logLines.join('\n'), 'utf8');
  saveStatusFile(statusFilePath, allStatus);
  if (onProgress) onProgress(caseIndex, statusEntry.status, testcase.case_title);

  return statusEntry;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (!args.taskDir) {
    console.error('错误: 必须指定 --task-dir 参数');
    process.exit(1);
  }

  const taskDir = path.resolve(args.taskDir);

  // Read task config
  const configPath = path.join(taskDir, 'task_config.yaml');
  if (!fs.existsSync(configPath)) {
    console.error(`错误: 任务配置不存在: ${configPath}`);
    process.exit(1);
  }
  const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

  // Read testcases
  const testcaseJsonPath = path.join(taskDir, 'testcase.json');
  if (!fs.existsSync(testcaseJsonPath)) {
    console.error(`错误: 用例文件不存在: ${testcaseJsonPath}`);
    process.exit(1);
  }
  const testcases = JSON.parse(fs.readFileSync(testcaseJsonPath, 'utf8'));

  if (testcases.length === 0) {
    console.error('错误: 无可执行的测试用例');
    process.exit(1);
  }

  const port = config.port || 8123;
  const clientId = config.client_id;
  const concurrency = config.concurrency || 3;

  if (!clientId) {
    console.error('错误: 配置中缺少 client_id');
    process.exit(1);
  }

  // Load knowledge config if present
  const testbedPath = path.join(taskDir, 'aitest-knowledge.yaml');
  let taskConfig = null;
  if (fs.existsSync(testbedPath)) {
    try {
      taskConfig = yaml.load(fs.readFileSync(testbedPath, 'utf8')) || null;
      console.log(`  测试知识库已加载: ${testbedPath}`);
    } catch (e) {
      console.warn(`警告: 测试知识库解析失败，已忽略: ${e.message}`);
    }
  }

  // Create HTTP client
  const client = createLocalClient(port, clientId);

  // Create log directory
  const timestamp = formatTimestamp(new Date());
  const logDir = path.join(taskDir, `run_log_${timestamp}`);
  fs.mkdirSync(logDir, { recursive: true });

  // Create task progress log stream
  const taskLogPath = path.join(logDir, 'task_log.log');
  const taskLogStream = fs.createWriteStream(taskLogPath, { flags: 'a', encoding: 'utf8' });

  function writeProgress(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    taskLogStream.write(line + '\n');
    console.log(line);
  }

  function logProgress() {
    const done = allStatus.filter(s => TERMINAL_STATES.includes(s.status)).length;
    const running = allStatus.filter(s => s.status === 'running').length;
    const pending = allStatus.filter(s => s.status === 'pending').length;
    const success = allStatus.filter(s => s.status === 'success').length;
    const fail = allStatus.filter(s => s.status === 'fail').length;
    const breakoff = allStatus.filter(s => s.status === 'breakoff').length;
    const rate = done > 0 ? ((success / done) * 100).toFixed(1) : '-';
    writeProgress(`进度: ${done}/${allStatus.length} | 运行中: ${running} | 待执行: ${pending} | 成功: ${success} | 失败: ${fail} | 中断: ${breakoff} | 通过率: ${rate}%`);
  }

  // Initialize status
  const statusFilePath = path.join(taskDir, 'run_case_status.json');
  const allStatus = testcases.map((tc, idx) => ({
    index: idx,
    case_id: tc.case_id || `case_${idx}`,
    case_title: tc.case_title || '',
    status: 'pending',
    task_id: null,
    dashboard_url: null,
    started_at: null,
    finished_at: null,
    error: null,
    log_file: null,
    message_count: 0,
    prompt: null,
    assert_result: null,
  }));
  saveStatusFile(statusFilePath, allStatus);

  console.log('====================================================================');
  console.log('              本地AI自动化测试 - 开始执行');
  console.log('====================================================================');
  console.log(`  用例总数: ${testcases.length}`);
  console.log(`  并发数: ${concurrency}`);
  console.log(`  服务地址: http://localhost:${port}`);
  console.log(`  任务目录: ${taskDir}`);
  console.log(`  日志目录: ${logDir}`);
  console.log(`  可视化面板: http://localhost:${port}/dashboard/#ai-test`);
  console.log('====================================================================\n');

  // Build task functions for concurrency pool
  const abortSignal = { aborted: false, reason: null };
  const onProgress = (caseIndex, status, caseTitle) => {
    const label = caseTitle || `case_${caseIndex}`;
    writeProgress(`用例 [${label}] → ${status}`);
    logProgress();
  };
  const taskFns = testcases.map((tc, idx) => {
    return () => executeSingleCase(client, tc, logDir, allStatus, statusFilePath, idx, port, taskConfig, abortSignal, onProgress);
  });

  writeProgress(`任务启动 — 总用例: ${testcases.length}, 并发数: ${concurrency}, 服务: http://localhost:${port}`);

  // Execute with concurrency limit
  const startTime = Date.now();
  await runWithConcurrency(taskFns, concurrency);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Final status
  const finalSummary = saveStatusFile(statusFilePath, allStatus);

  // Generate Markdown report
  const reportScriptPath = path.join(__dirname, 'generate_report.js');
  let reportFile = null;
  try {
    const result = spawnSync(process.execPath, [reportScriptPath, '--status-file', statusFilePath], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout) {
      reportFile = result.stdout.trim();
    } else if (result.stderr) {
      console.warn(`报告生成警告: ${result.stderr.trim()}`);
    }
  } catch (e) {
    console.warn(`报告生成失败(不阻塞): ${e.message}`);
  }

  console.log('\n====================================================================');
  console.log('              执行完成');
  console.log('====================================================================');
  console.log(`  耗时: ${elapsed}s`);
  console.log(`  成功: ${finalSummary.success}`);
  console.log(`  失败: ${finalSummary.fail}`);
  console.log(`  中断: ${finalSummary.breakoff}`);
  console.log(`  状态文件: ${statusFilePath}`);
  if (reportFile) {
    console.log(`  测试报告: ${reportFile}`);
  }
  console.log('====================================================================');

  // Output JSON summary for agent parsing
  console.log(JSON.stringify({
    success: true,
    elapsed_seconds: parseFloat(elapsed),
    total: finalSummary.total,
    summary: {
      success: finalSummary.success,
      fail: finalSummary.fail,
      breakoff: finalSummary.breakoff,
    },
    status_file: statusFilePath,
    report_file: reportFile,
    log_dir: logDir,
    dashboard_url: `http://localhost:${port}/dashboard/#ai-test`,
  }));

  taskLogStream.end();
}

main().catch(err => {
  console.error('执行器异常:', err.message);
  console.log(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
