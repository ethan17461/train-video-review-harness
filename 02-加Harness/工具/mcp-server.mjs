#!/usr/bin/env node
// 复盘工具的 MCP 服务：把 review-tools.mjs 里的 4 个功能交给 DeepSeek Harness 调用。
// 协议部分沿用 Codex v2 的 mcp-periods.mjs（不依赖第三方包）。
import readline from 'node:readline';
import {buildReview, workEvidence, compareGroups, saveReport, ToolError} from './review-tools.mjs';

const protocols = ['2024-11-05', '2025-03-26', '2025-06-18'];
const readOnly = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false};
const noArgs = {type: 'object', properties: {}, additionalProperties: false};

const tools = [
  {
    name: 'get_review_summary',
    title: '读取复盘结果',
    description: '只读。返回统计截止时间、达标线、每条作品发布后 24 小时和 7 天的播放量、是否达线、离达标线还差多少、汇总条数和数据问题。冲突的数据不给数值，标为「冲突-需人工核查」。缺少统计截止时间时返回停止。',
    inputSchema: noArgs, annotations: readOnly,
  },
  {
    name: 'get_work_evidence',
    title: '查看某条作品的来源',
    description: '只读。返回一条作品两个时间点的状态、播放量和来源行号。',
    inputSchema: {type: 'object', properties: {work_id: {type: 'string', minLength: 1, maxLength: 40}}, required: ['work_id'], additionalProperties: false},
    annotations: readOnly,
  },
  {
    name: 'compare_groups',
    title: '按组数条数',
    description: '只读。按「平台」或「标题」分组，返回每组在两个时间点的有效条数、达线条数和各条播放量，并提醒样本够不够下结论。做任何比较之前先调用它。',
    inputSchema: {type: 'object', properties: {by: {type: 'string', enum: ['平台', '标题']}}, required: ['by'], additionalProperties: false},
    annotations: readOnly,
  },
  {
    name: 'save_report',
    title: '检查并保存报告',
    description: '保存复盘报告的唯一方式。保存前会自动检查报告里提到的作品数字是否和数据一致：一致才保存到「复盘输出」文件夹；不一致会退回并列出问题，可以改一次；第二次仍不一致，会存成「待人工核查」版本。如果你确认没有写错、认为检查结果有争议，不要为了通过检查而改写，请保持原文并填写 dispute_note，报告会转人工核查。统计表由工具自动附上，报告里只写解读。',
    inputSchema: {type: 'object', properties: {
      report_markdown: {type: 'string', minLength: 1, maxLength: 50000},
      dispute_note: {type: 'string', minLength: 1, maxLength: 5000, description: '只在认为检查结果有争议时填写：争议在哪一处、依据是工具给的哪个数字、为什么认为检查有误。'},
    }, required: ['report_markdown'], additionalProperties: false},
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false},
  },
];

function checkArgs(args, allowed, required = []) {
  const bad = !args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some(k => !allowed.includes(k))
    || required.some(k => typeof args[k] !== 'string' || !args[k].trim());
  if (bad) throw new ToolError('INVALID_ARGUMENTS', '工具参数无效。');
}

const handlers = {
  get_review_summary(args) { checkArgs(args, []); return buildReview(); },
  get_work_evidence(args) { checkArgs(args, ['work_id'], ['work_id']); return workEvidence(args.work_id); },
  compare_groups(args) { checkArgs(args, ['by'], ['by']); return compareGroups(args.by); },
  save_report(args) {
    checkArgs(args, ['report_markdown', 'dispute_note'], ['report_markdown']);
    return saveReport(args.report_markdown, {disputeNote: args.dispute_note});
  },
};

const instructions = '本服务提供短视频数据复盘的 4 个工具。所有数字都以工具返回的为准；冲突数据不提供数值，需人工核查；缺少统计截止时间时必须停止；报告只能通过 save_report 保存。';

const send = x => process.stdout.write(JSON.stringify(x) + '\n');
const rpcError = (id, code, message) => ({jsonrpc: '2.0', id, error: {code, message}});
const response = (id, result) => ({jsonrpc: '2.0', id, result});

function handle(m) {
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') { send(rpcError(m?.id ?? null, -32600, 'Invalid Request')); return; }
  const {id, method, params = {}} = m;
  const notification = !Object.hasOwn(m, 'id');
  if (method === 'notifications/initialized') return;
  if (method === 'initialize') {
    if (!notification) send(response(id, {
      protocolVersion: protocols.includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18',
      capabilities: {tools: {listChanged: false}},
      serverInfo: {name: 'video-review', version: '1.0.0'},
      instructions,
    }));
    return;
  }
  if (method === 'ping') { if (!notification) send(response(id, {})); return; }
  if (method === 'tools/list') { if (!notification) send(response(id, {tools})); return; }
  if (method === 'tools/call') {
    if (notification) return;
    const name = params.name;
    if (typeof name !== 'string' || !Object.hasOwn(handlers, name)) { send(rpcError(id, -32602, 'Unknown tool')); return; }
    try {
      const payload = handlers[name](params.arguments ?? {});
      const failed = name === 'save_report' && payload.已保存 === false;
      send(response(id, {content: [{type: 'text', text: JSON.stringify(payload, null, 1)}], structuredContent: payload, isError: failed}));
    } catch (e) {
      const payload = {ok: false, 停止: Boolean(e.stopped), code: e.code || 'TOOL_ERROR', message: e.message || '工具执行失败'};
      send(response(id, {content: [{type: 'text', text: JSON.stringify(payload, null, 1)}], structuredContent: payload, isError: true}));
    }
    return;
  }
  if (!notification) send(rpcError(id, -32601, 'Method not found'));
}

const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity, terminal: false});
rl.on('line', line => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { send(rpcError(null, -32700, 'Parse error')); return; }
  try { handle(m); } catch { send(rpcError(m?.id ?? null, -32603, 'Internal error')); }
});
