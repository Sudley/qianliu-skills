#!/usr/bin/env node
'use strict';

const fs = require('fs');
const yaml = require('./vendor/js-yaml');

// ─── Argument parsing ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { config: null, concurrency: null, testcasePath: null, knowledgePath: null, testcaseType: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      args.config = argv[i + 1];
      i++;
    } else if (argv[i] === '--concurrency' && argv[i + 1]) {
      args.concurrency = parseInt(argv[i + 1], 10);
      i++;
    } else if (argv[i] === '--testcase-path' && argv[i + 1]) {
      args.testcasePath = argv[i + 1];
      i++;
    } else if (argv[i] === '--knowledge-path' && argv[i + 1]) {
      args.knowledgePath = argv[i + 1];
      i++;
    } else if (argv[i] === '--testcase-type' && argv[i + 1]) {
      args.testcaseType = argv[i + 1];
      i++;
    }
  }
  return args;
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

  if (!args.concurrency && !args.testcasePath && !args.knowledgePath && !args.testcaseType) {
    console.error('错误: 必须指定至少一个要更新的字段（--concurrency、--testcase-path 或 --knowledge-path）');
    process.exit(1);
  }

  if (args.concurrency && (args.concurrency < 1 || args.concurrency > 3)) {
    console.error('错误: --concurrency 值必须为 1-3');
    process.exit(1);
  }

  const config = yaml.load(fs.readFileSync(args.config, 'utf8')) || {};
  const updated = {};

  if (args.testcaseType) {
    config.testcase_type = args.testcaseType;
    updated.testcase_type = args.testcaseType;
  }

  if (args.testcasePath) {
    config.testcase_path = args.testcasePath;
    updated.testcase_path = args.testcasePath;
  }

  if (args.knowledgePath) {
    config.knowledge_path = args.knowledgePath;
    updated.knowledge_path = args.knowledgePath;
  }

  if (args.concurrency) {
    config.concurrency = args.concurrency;
    updated.concurrency = args.concurrency;
  }

  fs.writeFileSync(args.config, yaml.dump(config, { lineWidth: -1 }), 'utf8');

  console.log('配置已更新:');
  for (const [k, v] of Object.entries(updated)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log(JSON.stringify({ success: true, updated }));
}

main();
