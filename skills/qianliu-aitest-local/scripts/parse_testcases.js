#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
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

// ─── Transform row from Chinese headers to English keys ─────────────────────

function transformRow(row) {
  const result = {};
  for (const [cnKey, enKey] of Object.entries(COLUMN_MAP)) {
    result[enKey] = row[cnKey] || '';
  }
  return result;
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
  const testcaseType = config.testcase_type || 'xlsx';

  // Validate testcase_path
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
      validCases = chunks.filter(chunk =>
        /###\s*(前置条件|前置步骤|前置|操作步骤|期望结果|后置条件|后置步骤|后置)/.test(chunk)
      );
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

  console.log(`\n预解析完成!`);
  console.log(`  总行数: ${totalRows}`);
  console.log(`  有效用例数: ${validCases.length}`);
  console.log(JSON.stringify({
    success: true,
    total_rows: totalRows,
    valid_cases: validCases.length,
  }));
}

main();
