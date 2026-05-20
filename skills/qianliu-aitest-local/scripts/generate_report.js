#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');

// ─── Argument parsing ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { statusFile: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--status-file' && argv[i + 1]) {
      args.statusFile = argv[i + 1];
      i++;
    }
  }
  return args;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

function formatDuration(ms) {
  if (ms == null || ms < 0) return '-';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (secs === 0) return `${minutes}分钟`;
  return `${minutes}分${secs}秒`;
}

function formatDateTime(isoStr) {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatTimestamp(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function truncate(str, maxLen) {
  if (!str) return '-';
  const s = String(str);
  return s.length > maxLen ? s.substring(0, maxLen) + '...' : s;
}

function statusIcon(status) {
  if (status === 'success') return '✅';
  if (status === 'fail') return '❌';
  if (status === 'breakoff') return '⚠️';
  if (status === 'pending') return '⏳';
  if (status === 'running') return '🔄';
  return status || '-';
}

function getDashboardBaseUrl(cases) {
  for (const c of cases) {
    if (c.dashboard_url) {
      const match = c.dashboard_url.match(/^(https?:\/\/[^#]+#ai-test)/);
      if (match) return match[1];
      return c.dashboard_url.replace(/\/\d+$/, '');
    }
  }
  return null;
}

// ─── Report generation ──────────────────────────────────────────────────────

function generateReport(statusData, taskDir) {
  const cases = statusData.cases || [];
  const total = statusData.total || cases.length;
  const success = statusData.success || 0;
  const fail = statusData.fail || 0;
  const breakoff = statusData.breakoff || 0;

  // Compute total execution duration from actual case times
  const startTimes = cases.map(c => c.started_at ? new Date(c.started_at).getTime() : null).filter(Boolean);
  const endTimes = cases.map(c => c.finished_at ? new Date(c.finished_at).getTime() : null).filter(Boolean);
  let totalDuration = '-';
  if (startTimes.length > 0 && endTimes.length > 0) {
    totalDuration = formatDuration(Math.max(...endTimes) - Math.min(...startTimes));
  }

  const passRate = total > 0 ? ((success / total) * 100).toFixed(1) : '0.0';
  const successPct = total > 0 ? ((success / total) * 100).toFixed(1) : '0.0';
  const failPct = total > 0 ? ((fail / total) * 100).toFixed(1) : '0.0';
  const breakoffPct = total > 0 ? ((breakoff / total) * 100).toFixed(1) : '0.0';

  const overallStatus = (fail + breakoff === 0)
    ? '> 整体状态：✅ 全部通过'
    : `> 整体状态：❌ 未全部通过（${fail} 个用例失败${breakoff > 0 ? `，${breakoff} 个中断` : ''}）`;

  const dashboardUrl = getDashboardBaseUrl(cases);
  const now = new Date();

  const lines = [];

  // ── Header ──────────────────────────────────────────────────────────────
  lines.push('# 本地自动化测试报告');
  lines.push('');
  lines.push(`**生成时间**: ${formatDateTime(now.toISOString())}  `);
  lines.push(`**任务目录**: ${taskDir}  `);
  if (dashboardUrl) {
    lines.push(`**可视化地址**: ${dashboardUrl}  `);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Summary ──────────────────────────────────────────────────────────────
  lines.push('## 执行摘要');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|------|------|');
  lines.push(`| 总用例数 | ${total} |`);
  lines.push(`| ✅ 成功 | ${success} (${successPct}%) |`);
  lines.push(`| ❌ 失败 | ${fail} (${failPct}%) |`);
  lines.push(`| ⚠️ 中断 | ${breakoff} (${breakoffPct}%) |`);
  lines.push(`| 通过率 | ${passRate}% |`);
  lines.push(`| 执行耗时 | ${totalDuration} |`);
  lines.push('');
  lines.push(overallStatus);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Failed / breakoff case details ──────────────────────────────────────
  const failedCases = cases.filter(c => c.status === 'fail' || c.status === 'breakoff');
  if (failedCases.length > 0) {
    lines.push('## ❌ 失败 / 中断用例详情');
    lines.push('');
    failedCases.forEach((c, i) => {
      const duration = (c.started_at && c.finished_at)
        ? formatDuration(new Date(c.finished_at).getTime() - new Date(c.started_at).getTime())
        : '-';
      const startStr = c.started_at ? formatDateTime(c.started_at) : '-';
      const endTime = c.finished_at ? formatDateTime(c.finished_at).split(' ')[1] : '-';
      const timeRange = (c.started_at && c.finished_at)
        ? `${startStr} → ${endTime}（耗时 ${duration}）`
        : '-';

      lines.push(`### [${i + 1}] ${c.case_id} — ${c.case_title || '未命名'}`);
      lines.push(`- **状态**：${statusIcon(c.status)} ${c.status === 'fail' ? '失败' : '中断'}`);
      lines.push(`- **断言结果**：${c.assert_result || '-'}`);
      lines.push(`- **执行时段**：${timeRange}`);
      if (c.dashboard_url) {
        lines.push(`- **仪表板**：[查看详情](${c.dashboard_url})`);
      }
      if (c.error) {
        lines.push(`- **错误信息**：${c.error}`);
      }
      lines.push('');
    });
    lines.push('---');
    lines.push('');
  }

  // ── Full case detail list ───────────────────────────────────────────────
  lines.push('## 全部用例执行明细');
  lines.push('');

  cases.forEach((c, i) => {
    const duration = (c.started_at && c.finished_at)
      ? formatDuration(new Date(c.finished_at).getTime() - new Date(c.started_at).getTime())
      : '-';
    const assertSummary = truncate(c.assert_result, 50);
    const dashLink = c.dashboard_url ? `[查看](${c.dashboard_url})` : '-';
    const logLink = c.log_file
      ? `[日志](file://${c.log_file.replace(/\\/g, '/')})`
      : '-';
    lines.push(`**${i + 1}. ${statusIcon(c.status)} ${c.case_id} — ${c.case_title || '未命名'}**`);
    lines.push(`- 耗时：${duration}`);
    lines.push(`- 断言：${assertSummary}`);
    lines.push(`- 仪表板：${dashLink}`);
    lines.push(`- 日志：${logLink}`);
    lines.push('');
  });

  return lines.join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);

  if (!args.statusFile) {
    console.error('错误: 必须指定 --status-file 参数');
    process.exit(1);
  }

  const statusFilePath = path.resolve(args.statusFile);
  if (!fs.existsSync(statusFilePath)) {
    console.error(`错误: 状态文件不存在: ${statusFilePath}`);
    process.exit(1);
  }

  let statusData;
  try {
    statusData = JSON.parse(fs.readFileSync(statusFilePath, 'utf8'));
  } catch (e) {
    console.error(`错误: 状态文件解析失败: ${e.message}`);
    process.exit(1);
  }

  const taskDir = path.dirname(statusFilePath);
  const reportContent = generateReport(statusData, taskDir);

  const timestamp = formatTimestamp(new Date());
  const reportFile = path.join(taskDir, `test_report_${timestamp}.md`);

  fs.writeFileSync(reportFile, reportContent, 'utf8');

  // Output only the report file path for easy parsing by callers
  console.log(reportFile);
}

main();
