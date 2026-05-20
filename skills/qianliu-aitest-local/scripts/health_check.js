#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { request } = require('./lib/http_client');
const yaml = require('./vendor/js-yaml');

// ─── Argument parsing ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { port: 8123, configDir: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      args.port = parseInt(argv[i + 1], 10);
      i++;
    } else if (argv[i] === '--config-dir' && argv[i + 1]) {
      args.configDir = argv[i + 1];
      i++;
    }
  }
  return args;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const configDir = args.configDir || path.join(process.cwd(), '.qianliu', '.qianliu-aitest-local');
  const configFile = path.join(configDir, 'aitest-local-config.yaml');

  console.log(`正在检查本地AI测试服务 http://localhost:${args.port} ...`);

  try {
    const res = await request('GET', `http://localhost:${args.port}/api/v1/health`, { timeout: 5000 });
    const data = res.data;

    if (!data || data.status !== 'healthy') {
      console.error('服务响应异常:', JSON.stringify(data));
      process.exit(1);
    }

    console.log(`服务连接成功!`);
    console.log(`  client_id: ${data.client_id}`);
    console.log(`  version: ${data.version || 'unknown'}`);
    console.log(`  supported_task_types: ${(data.supported_task_types || []).join(', ')}`);

    // Ensure config directory exists
    fs.mkdirSync(configDir, { recursive: true });

    // Read existing config or create new
    let config = {};
    if (fs.existsSync(configFile)) {
      const content = fs.readFileSync(configFile, 'utf8');
      config = yaml.load(content) || {};
    }

    // Update port and client_id
    config.port = args.port;
    config.client_id = data.client_id;

    // Write config
    fs.writeFileSync(configFile, yaml.dump(config, { lineWidth: -1 }), 'utf8');

    console.log(`\n配置已保存到: ${configFile}`);
    console.log(JSON.stringify({ success: true, port: args.port, client_id: data.client_id, config_path: configFile }));

  } catch (err) {
    console.error(`\n无法连接到本地AI测试服务 (http://localhost:${args.port})`);
    console.error(`错误: ${err.message}`);
    console.error(`\n请确认：`);
    console.error(`  1. 千流客户端已安装并启动`);
    console.error(`  2. 服务端口为 ${args.port}（若端口不同，请使用 --port 参数指定）`);
    console.log(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

main();
