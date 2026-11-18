// 运行：node --test 工具/tools.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildReview, compareGroups, checkReport, saveReport, resetAttempts, ROOT} from './review-tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const baselineReport = path.join(ROOT, '..', '01-基线测试-无Harness', '复盘报告.md');

const GOOD_REPORT = `## 一句话结论
发布后 24 小时有效 4 条、达线 1 条（W02）；发布后 7 天有效 4 条、达线 3 条（W01、W02、W06）。W04 第 1 天数据冲突，已转人工核查。

## 需要人工核查
- W04 发布后 24 小时有两个不同数值（R08、R09），请人工核对。其余作品照常统计。

## 离线很近的作品（只陈述事实）
- W06 发布后 24 小时 999，差 1 达线；7 天 1,000，正好达线。
- W01 发布后 24 小时 850，差 150；7 天 1300，比 24 小时多 450。
- W04 发布后 7 天 900，差 100。

## 待验证假设
- 「夜车去高地」两条（W01、W02）7 天都到 1300。只用了 2 条数据，少于 10 条，不能叫规律。依据：只有标题和播放量。验证方法：再发 10 条同题材视频对比。

## 下次建议
- 同一选题分别试两个开头，记录 24 小时和 7 天播放，攒到 10 条再比较。第 3、4 节的数据补齐后再看。
`;

function tempData(edit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-data-'));
  for (const f of fs.readdirSync(path.join(ROOT, '数据'))) fs.copyFileSync(path.join(ROOT, '数据', f), path.join(dir, f));
  if (edit) {
    const file = path.join(dir, '复盘设置.json');
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    edit(s);
    fs.writeFileSync(file, JSON.stringify(s));
  }
  return dir;
}

test('汇总条数和正确答案一致', () => {
  const r = buildReview();
  assert.equal(r.汇总['24h'].有效条数, 4);
  assert.deepEqual(r.汇总['24h'].达线作品, ['W02']);
  assert.equal(r.汇总['7d'].有效条数, 4);
  assert.deepEqual(r.汇总['7d'].达线作品, ['W01', 'W02', 'W06']);
  assert.deepEqual(r.汇总['24h'].冲突需人工核查, ['W04']);
});

test('决定 1：冲突的数据不给数字', () => {
  const w04 = buildReview().作品.find(w => w.编号 === 'W04');
  assert.equal(w04.数据['24h'].状态, '冲突-需人工核查');
  assert.equal(w04.数据['24h'].播放量, undefined);
  const text = JSON.stringify(w04.数据['24h']);
  assert.ok(!text.includes('300') && !text.includes('400'));
});

test('决定 4：按平台分组时提醒样本不够', () => {
  const g = compareGroups('平台');
  for (const group of g.分组) {
    assert.equal(group['24h'].有效条数, 2);
    assert.equal(group['24h'].样本是否够, false);
  }
});

test('决定 5：检查点能抓到基线报告第 69 行的错', () => {
  const problems = checkReport(fs.readFileSync(baselineReport, 'utf8'), buildReview());
  const line69 = problems.filter(p => p.行 === 69);
  assert.ok(line69.some(p => p.问题.startsWith('W02') && p.问题.includes('1000')));
});

test('决定 5：检查点能抓到把 W04 按 400 算', () => {
  const problems = checkReport('W04 发布后 24 小时 400。\n## 待验证假设\n无', buildReview());
  assert.equal(problems.length, 1);
});

test('决定 5：写对的报告不会被误判', () => {
  assert.deepEqual(checkReport(GOOD_REPORT, buildReview()), []);
});

test('决定 5：分组条数不会被当成总数误判（第一次测试发现的问题）', () => {
  const line = '- 依据：平台分组里 Instagram 24 小时有效 2 条、达线 1 条（W02 1000、W06 999）；TikTok 24 小时有效 2 条、达线 0 条（W01 850、W03 0）。7 天口径 Instagram 有效 3 条达线 2 条，TikTok 有效 1 条达线 1 条。';
  assert.deepEqual(checkReport(`${line}\n## 待验证假设\n无`, buildReview()), []);
});

test('决定 5：「分别」按顺序对应、「不按 0 算」不误判（第一次重跑发现的问题）', () => {
  const text = [
    '- W03「湖区慢车」7 天：无可用播放量（R07），该时间点缺数，不按 0 算、也不用其他时间快照代替。',
    '2. 依据：W01、W02、W06 的 7 天比 24 小时分别多 450、300、1。',
    '## 待验证假设', '无',
  ].join('\n');
  assert.deepEqual(checkReport(text, buildReview()), []);
});

test('决定 5：「分别」写错顺序仍然能抓到', () => {
  const problems = checkReport('W01、W02 的 7 天比 24 小时分别多 300、450。\n## 待验证假设\n无', buildReview());
  assert.equal(problems.length, 2);
});

test('决定 5：总数写错仍然能抓到', () => {
  const problems = checkReport('发布后 24 小时有效 5 条、达线 1 条。\n## 待验证假设\n无', buildReview());
  assert.equal(problems.length, 1);
});

test('决定 5 + 6：通过才保存；改一次仍不对就转人工；只写进输出文件夹', () => {
  resetAttempts();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'review-out-'));
  const ok = saveReport(GOOD_REPORT, {outputDir: out});
  assert.equal(ok.已保存, true);
  const bad = GOOD_REPORT.replace('W06 发布后 24 小时 999', 'W06 发布后 24 小时 1000');
  const first = saveReport(bad, {outputDir: out});
  assert.equal(first.已保存, false);
  const second = saveReport(bad, {outputDir: out});
  assert.equal(second.已保存, true);
  assert.match(second.检查结果, /转人工/);
  const files = fs.readdirSync(out);
  assert.equal(files.length, 2);
  assert.ok(files.some(f => f.startsWith('待人工核查-')));
});

test('不迎合检查：有争议时不改写，直接转人工，并留下争议说明', () => {
  resetAttempts();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'review-out-'));
  const disputed = GOOD_REPORT.replace('W06 发布后 24 小时 999', 'W06 发布后 24 小时 1000');
  const result = saveReport(disputed, {outputDir: out, disputeNote: '我认为第 5 行没有写错，依据是工具给的数字。'});
  assert.equal(result.检查结果, '有争议，已转人工');
  const files = fs.readdirSync(out);
  assert.equal(files.length, 1);
  assert.ok(files[0].startsWith('待人工核查-'));
  const text = fs.readFileSync(path.join(out, files[0]), 'utf8');
  assert.match(text, /我认为第 5 行没有写错/);
  assert.match(text, /检查点提出的问题/);
  assert.match(text, /W06 发布后 24 小时 1000/);
});

test('不迎合检查：填了争议说明也不能把错的存成正式报告，空说明会被拒绝', () => {
  resetAttempts();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'review-out-'));
  const bad = GOOD_REPORT.replace('W06 发布后 24 小时 999', 'W06 发布后 24 小时 1000');
  saveReport(bad, {outputDir: out, disputeNote: '我觉得没问题'});
  assert.ok(fs.readdirSync(out).every(f => !f.startsWith('复盘报告-')));
  assert.throws(() => saveReport(bad, {outputDir: out, disputeNote: '   '}), e => e.code === 'INVALID_ARGUMENTS');
});

test('不迎合检查：被退回后才通过的报告，会留下退回记录', () => {
  resetAttempts();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'review-out-'));
  const bad = GOOD_REPORT.replace('W06 发布后 24 小时 999', 'W06 发布后 24 小时 1000');
  assert.equal(saveReport(bad, {outputDir: out}).已保存, false);
  assert.equal(saveReport(GOOD_REPORT, {outputDir: out}).检查结果, '通过');
  const [file] = fs.readdirSync(out);
  const text = fs.readFileSync(path.join(out, file), 'utf8');
  assert.match(text, /## 检查记录（由代码生成）/);
  assert.match(text, /W06 发布后 24 小时 1000/);
});

test('一次通过的报告没有检查记录', () => {
  resetAttempts();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'review-out-'));
  saveReport(GOOD_REPORT, {outputDir: out});
  const [file] = fs.readdirSync(out);
  assert.doesNotMatch(fs.readFileSync(path.join(out, file), 'utf8'), /检查记录/);
});

test('停止条件：缺统计截止时间就停', () => {
  const dir = tempData(s => { delete s['统计截止时间']; });
  assert.throws(() => buildReview(dir), e => e.code === 'MISSING_AS_OF' && e.stopped === true);
});

test('MCP 服务能启动并列出 4 个工具', async () => {
  const child = spawn(process.execPath, [path.join(here, 'mcp-server.mjs')], {stdio: ['pipe', 'pipe', 'inherit']});
  const replies = [];
  child.stdout.on('data', b => replies.push(...b.toString().trim().split('\n').map(l => JSON.parse(l))));
  const call = m => child.stdin.write(JSON.stringify(m) + '\n');
  call({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18'}});
  call({jsonrpc: '2.0', id: 2, method: 'tools/list'});
  call({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'get_review_summary', arguments: {}}});
  await new Promise(r => setTimeout(r, 800));
  child.kill();
  const list = replies.find(r => r.id === 2).result.tools.map(t => t.name);
  assert.deepEqual(list, ['get_review_summary', 'get_work_evidence', 'compare_groups', 'save_report']);
  const save = replies.find(r => r.id === 2).result.tools.find(t => t.name === 'save_report');
  assert.ok(save.inputSchema.properties.dispute_note);
  assert.deepEqual(save.inputSchema.required, ['report_markdown']);
  const summary = replies.find(r => r.id === 3).result.structuredContent;
  assert.equal(summary.汇总['7d'].达线条数, 3);
});
