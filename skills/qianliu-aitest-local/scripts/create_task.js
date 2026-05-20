#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const yaml = require('./vendor/js-yaml');
const { readXlsx } = require('./vendor/xlsx-reader');

// ─── Column mapping: Chinese headers → English keys ─────────────────────────

const COLUMN_MAP = {
  '特性名称': 'feature_name',
  '用例ID': 'case_id',
  '用例标题': 'case_title',
  '预置条件': 'preconditions',
  '操作步骤': 'steps',
  '后置条件': 'postconditions',
  '期望结果': 'expected_results',
  '测试方法': 'test_method',
  '用例类型': 'case_type',
  '可自动化': 'is_automatable',
  '标签': 'tags',
  '作者': 'author',
  '产品需求ID': 'requirement_id',
  '网上问题ID': 'issue_id',
  '测试经验ID': 'experience_id',
  '用例级别': 'priority',
  '备注': 'remarks',
};

// ─── Argument parsing ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { config: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      args.config = argv[i + 1];
      i++;
    }
  }
  return args;
}

// ─── Compute 8-char MD5 from all config key-values ─────────────────────────

function computeConfigHash(config) {
  const sortedEntries = Object.keys(config)
    .filter(k => config[k] !== undefined && config[k] !== null)
    .sort()
    .map(k => [k, config[k]]);
  const content = sortedEntries.map(([k, v]) => `${k}=${v}`).join('&');
  return crypto.createHash('md5').update(content).digest('hex').substring(0, 8);
}

// ─── Transform row from Chinese headers to English keys ─────────────────────

function transformRow(row) {
  const result = {};
  for (const [cnKey, enKey] of Object.entries(COLUMN_MAP)) {
    result[enKey] = row[cnKey] || '';
  }
  return result;
}

// ─── Parse a single markdown case chunk into testcase object ────────────────

function parseMarkdownCase(chunk) {
  const tc = {
    feature_name: '', case_id: '', case_title: '',
    preconditions: '', steps: '', postconditions: '', expected_results: '',
    test_method: '', case_type: '', is_automatable: '', tags: '',
    author: '', requirement_id: '', issue_id: '', experience_id: '',
    priority: '', remarks: '',
  };

  // Extract H2 title (optional)
  const titleMatch = chunk.match(/^##\s+(.+)/m);
  if (titleMatch) tc.case_title = titleMatch[1].trim();

  // Split by H3 sections
  const sectionRegex = /###\s+(前置条件|前置步骤|前置|操作步骤|期望结果|后置条件|后置步骤|后置)\s*\n([\s\S]*?)(?=###\s+(?:前置条件|前置步骤|前置|操作步骤|期望结果|后置条件|后置步骤|后置)|$)/g;
  const fieldMap = {
    '前置条件': 'preconditions', '前置步骤': 'preconditions', '前置': 'preconditions',
    '操作步骤': 'steps',
    '期望结果': 'expected_results',
    '后置条件': 'postconditions', '后置步骤': 'postconditions', '后置': 'postconditions',
  };
  let m;
  while ((m = sectionRegex.exec(chunk)) !== null) {
    const field = fieldMap[m[1]];
    if (field) tc[field] = m[2].trim();
  }

  return tc;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);

  if (!args.config) {
    console.error('错误: 必须指定 --config 参数');
    process.exit(1);
  }

  if (!fs.existsSync(args.config)) {
    console.error(`错误: 配置文件不存在: ${args.config}`);
    process.exit(1);
  }

  const config = yaml.load(fs.readFileSync(args.config, 'utf8')) || {};
  const configDir = path.dirname(args.config);
  const testcaseType = config.testcase_type || 'xlsx';

  // Validate required fields
  if (!config.testcase_path) {
    console.error('错误: 配置中缺少 testcase_path，请先通过 update_config.js 配置用例文件路径');
    console.log(JSON.stringify({ success: false, error: 'missing_testcase_path' }));
    process.exit(1);
  }

  // Resolve testcase path (support relative paths)
  const testcasePath = path.isAbsolute(config.testcase_path)
    ? config.testcase_path
    : path.resolve(process.cwd(), config.testcase_path);

  if (!fs.existsSync(testcasePath)) {
    console.error(`错误: 测试用例文件不存在: ${testcasePath}`);
    console.log(JSON.stringify({ success: false, error: 'testcase_file_not_found', path: testcasePath }));
    process.exit(1);
  }

  // Parse by type
  console.log(`正在解析测试用例文件: ${testcasePath}`);
  let validCases;
  let totalRows;
  try {
    if (testcaseType === 'json') {
      const raw = JSON.parse(fs.readFileSync(testcasePath, 'utf8'));
      if (!Array.isArray(raw)) throw new Error('JSON 文件须为数组');
      totalRows = raw.length;
      validCases = raw.filter(tc => tc.case_id || tc.case_title || tc.steps);
    } else if (testcaseType === 'markdown') {
      const text = fs.readFileSync(testcasePath, 'utf8');
      const chunks = text.replace(/^\[\/\/\]:.*$/gm, '').split(/\n---\n/);
      totalRows = chunks.length;
      validCases = chunks
        .filter(chunk => /###\s*(前置条件|操作步骤|期望结果|后置条件)/.test(chunk))
        .map(chunk => parseMarkdownCase(chunk));
    } else {
      // xlsx (default)
      const rows = readXlsx(testcasePath);
      totalRows = rows.length;
      validCases = rows.map(transformRow).filter(tc => tc.case_id || tc.case_title || tc.steps);
    }
  } catch (err) {
    console.error(`错误: 解析测试用例文件失败: ${err.message}`);
    console.log(JSON.stringify({ success: false, error: 'parse_error', message: err.message }));
    process.exit(1);
  }

  // Compute task hash and create task directory
  const hash = computeConfigHash(config);
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const taskDirName = `task_${dateStr}_${timeStr}_${hash}`;
  const localTasksDir = path.join(configDir, 'local_tasks');
  const taskDir = path.join(localTasksDir, taskDirName);

  fs.mkdirSync(taskDir, { recursive: true });

  // Copy config as task_config.yaml
  const taskConfigPath = path.join(taskDir, 'task_config.yaml');
  fs.writeFileSync(taskConfigPath, yaml.dump(config, { lineWidth: -1 }), 'utf8');

  // Copy knowledge file to task directory if configured
  let testbedCopied = false;
  if (config.knowledge_path) {
    const testbedSrc = path.isAbsolute(config.knowledge_path)
      ? config.knowledge_path
      : path.resolve(process.cwd(), config.knowledge_path);
    if (fs.existsSync(testbedSrc)) {
      const testbedDest = path.join(taskDir, 'aitest-knowledge.yaml');
      fs.copyFileSync(testbedSrc, testbedDest);
      testbedCopied = true;
      console.log(`  测试知识库已复制: ${testbedDest}`);
    } else {
      console.warn(`警告: 测试知识库文件不存在，已跳过: ${testbedSrc}`);
    }
  }

  // Auto-generate timestamp for empty case_id and case_title
  validCases.forEach((tc, idx) => {
    const autoId = `TC_${dateStr}${timeStr}_${String(idx + 1).padStart(3, '0')}`;
    if (!tc.case_id) tc.case_id = autoId;
    if (!tc.case_title) tc.case_title = autoId;
  });

  // Write testcase.json
  const testcaseJsonPath = path.join(taskDir, 'testcase.json');
  fs.writeFileSync(testcaseJsonPath, JSON.stringify(validCases, null, 2), 'utf8');

  // Output summary
  console.log(`\n任务目录创建完成!`);
  console.log(`  总行数: ${totalRows}`);
  console.log(`  有效用例数: ${validCases.length}`);
  console.log(`  任务目录: ${taskDir}`);
  console.log(`  用例文件: ${testcaseJsonPath}`);
  console.log(`  任务配置: ${taskConfigPath}`);

  console.log(JSON.stringify({
    success: true,
    total_rows: totalRows,
    valid_cases: validCases.length,
    task_dir: taskDir,
    task_dir_name: taskDirName,
    testcase_json: testcaseJsonPath,
    task_config: taskConfigPath,
    testbed_copied: testbedCopied,
  }));
}

main();
