// 复盘工具的全部逻辑。数字只在这里算，AI 只拿结果。
// 计算核心沿用 Codex v2 的 review-periods.mjs（已测试），这里负责：
//   读数据和设置 → 整理成给 AI 的结果（冲突不给数，决定 1）
//   按组数条数（决定 4）→ 检查报告里的数字（决定 5）→ 只往「复盘输出」保存（决定 6）
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runPeriodReview} from './review-periods.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, '数据');
export const OUTPUT_DIR = path.join(ROOT, '复盘输出');
const PERIODS = [
  {id: '24h', label: '发布后 24 小时'},
  {id: '7d', label: '发布后 7 天'},
];

export class ToolError extends Error {
  constructor(code, message, stopped = false) {
    super(message);
    this.code = code;
    this.stopped = stopped;
  }
}

// ---------- 读数据 ----------
function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  const header = lines[0].split(',').map(s => s.trim());
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

export function loadSettings(dataDir = DATA_DIR) {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(path.join(dataDir, '复盘设置.json'), 'utf8'));
  } catch {
    throw new ToolError('SETTINGS_UNAVAILABLE', '读不到「复盘设置.json」，复盘停止。请负责人检查设置文件。', true);
  }
  return {
    asOf: s['统计截止时间'] || null,
    threshold: s['达标线'],
    minSample: s['下结论的最少样本数'] ?? 10,
  };
}

export function loadInput(dataDir = DATA_DIR) {
  let works, rows;
  try {
    works = readCsv(path.join(dataDir, '作品清单.csv'));
    rows = readCsv(path.join(dataDir, '播放快照.csv'));
  } catch {
    throw new ToolError('INPUT_UNAVAILABLE', '读不到作品清单或播放快照，复盘停止。', true);
  }
  return {
    works: works.map(w => ({
      id: w['作品编号'], title: w['标题'], platform: w['平台'], account: w['账号'],
      platformWorkId: w['平台作品ID'], publishedAt: w['发布时间(UTC)'],
    })),
    snapshots: rows.map(r => {
      const raw = r['累计播放量'];
      return {
        rowId: r['行号'], platform: r['平台'], account: r['账号'], platformWorkId: r['平台作品ID'],
        capturedAt: r['抓取时间(UTC)'], views: raw === '' ? null : Number(raw),
      };
    }),
  };
}

// ---------- 复盘结果（给 AI 看的版本） ----------
const STATUS = {valid: '有效', missing: '缺数', conflict: '冲突-需人工核查', not_due: '未到期'};

export function buildReview(dataDir = DATA_DIR) {
  const settings = loadSettings(dataDir);
  if (!settings.asOf) {
    throw new ToolError('MISSING_AS_OF',
      '缺少统计截止时间，复盘停止。没有截止时间，就判断不了哪些观察点已经到期、哪些快照可以用。' +
      '请负责人在「数据/复盘设置.json」里补上统计截止时间后再复盘。不要自己假设截止时间。', true);
  }
  const input = loadInput(dataDir);
  let raw;
  try {
    raw = runPeriodReview({...input, asOf: settings.asOf, threshold: settings.threshold, dataNature: 'fictional_demo'});
  } catch (e) {
    throw new ToolError(e.code || 'REVIEW_FAILED', e.message, true);
  }
  const th = raw.threshold;

  const works = raw.works.map(w => {
    const periods = {};
    for (const p of PERIODS) {
      const pt = w.periods[p.id];
      const item = {
        时间点: p.label,
        状态: STATUS[pt.status],
        来源行: pt.evidence.filter(e => e.disposition !== 'duplicate').map(e => e.rowId),
      };
      if (pt.status === 'valid') {
        item.播放量 = pt.views;
        item.是否达线 = pt.reached;
        if (!pt.reached) item.离达标线还差 = th - pt.views;
      }
      if (pt.status === 'conflict') {
        // 决定 1：冲突不给任何数字，AI 想挑也没得挑。
        item.说明 = `同一时间点有 ${item.来源行.length} 个不同数值，数值不提供。请人工核对 ${item.来源行.join('、')}。只转这一条，其余作品照常统计。`;
      }
      if (pt.status === 'missing') item.说明 = '这个时间点没有可用的播放量，不按 0 算，也不用其他时间的快照代替。';
      if (pt.status === 'not_due') item.说明 = '统计截止时还没到这个观察时间。';
      periods[p.id] = item;
    }
    const v24 = periods['24h'].播放量, v7 = periods['7d'].播放量;
    const out = {编号: w.id, 标题: w.title, 平台: w.platform, 账号: w.account, 数据: periods};
    if (Number.isInteger(v24) && Number.isInteger(v7)) out['7天比24小时多'] = v7 - v24;
    const others = w.otherSnapshots.filter(o => o.disposition === 'outside_observation_time');
    if (others.length) out.不在观察时间点的快照 = others.map(o => `${o.rowId}（${o.capturedAt}，不使用）`);
    return out;
  });

  const summary = {};
  for (const p of PERIODS) {
    const list = works.map(w => ({id: w.编号, ...w.数据[p.id]}));
    const valid = list.filter(x => x.状态 === '有效');
    summary[p.id] = {
      时间点: p.label,
      作品总数: list.length,
      有效条数: valid.length,
      达线条数: valid.filter(x => x.是否达线).length,
      达线作品: valid.filter(x => x.是否达线).map(x => x.id),
      未达线作品: valid.filter(x => !x.是否达线).map(x => ({编号: x.id, 播放量: x.播放量, 离达标线还差: x.离达标线还差})),
      缺数作品: list.filter(x => x.状态 === '缺数').map(x => x.id),
      冲突需人工核查: list.filter(x => x.状态 === '冲突-需人工核查').map(x => x.id),
      未到期作品: list.filter(x => x.状态 === '未到期').map(x => x.id),
    };
  }

  const duplicates = raw.works.flatMap(w => Object.values(w.periods).flatMap(pt =>
    pt.evidence.filter(e => e.disposition === 'duplicate').map(e => `${e.rowId} 和 ${e.duplicateOf} 完全重复，只算一次`)));

  return {
    统计截止时间: raw.asOf,
    达标线: th,
    下结论的最少样本数: settings.minSample,
    口径: '每条作品按发布时间分别看发布后 24 小时和 7 天两个准确时间点；达到达标线（含等于）算达线。两个时间点分开判断，不合并。',
    汇总: summary,
    作品: works,
    数据问题: {
      重复: duplicates,
      对不上作品的记录: raw.anomalies.unmatched.map(u => `${u.rowId}（${u.platformWorkId} 不在作品清单里，不计入）`),
    },
  };
}

export function workEvidence(workId, dataDir = DATA_DIR) {
  const r = buildReview(dataDir);
  const w = r.作品.find(x => x.编号 === String(workId).trim());
  if (!w) throw new ToolError('WORK_NOT_FOUND', `没有编号为 ${workId} 的作品。`);
  return {统计截止时间: r.统计截止时间, 达标线: r.达标线, 作品: w};
}

// ---------- 决定 4：按组数条数 ----------
const GROUP_FIELDS = {平台: '平台', 标题: '标题'};

export function compareGroups(by, dataDir = DATA_DIR) {
  if (!Object.hasOwn(GROUP_FIELDS, by)) throw new ToolError('INVALID_ARGUMENTS', 'by 只能是「平台」或「标题」。');
  const r = buildReview(dataDir);
  const min = r.下结论的最少样本数;
  const groups = new Map();
  for (const w of r.作品) {
    const key = w[GROUP_FIELDS[by]];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }
  const result = [...groups.entries()].map(([key, list]) => {
    const periods = {};
    for (const p of PERIODS) {
      const valid = list.filter(w => w.数据[p.id].状态 === '有效');
      const n = valid.length;
      periods[p.id] = {
        有效条数: n,
        达线条数: valid.filter(w => w.数据[p.id].是否达线).length,
        各条播放量: valid.map(w => ({编号: w.编号, 播放量: w.数据[p.id].播放量})),
        样本是否够: n >= min,
        提醒: n >= min
          ? `样本 ${n} 条，达到 ${min} 条，可以作为观察结论，但仍需写明用了 ${n} 条。`
          : `样本只有 ${n} 条，少于 ${min} 条：不能叫规律，只能写进「待验证假设」，并写明用了 ${n} 条。`,
      };
    }
    return {[by]: key, 作品: list.map(w => w.编号), ...periods};
  });
  return {分组方式: by, 最少样本数: min, 分组: result};
}

// ---------- 决定 5：检查报告里的数字 ----------
// 规则：报告里提到某条视频的数字，必须是工具给过的数字（播放量、离线差距、7 天比 24 小时多多少）。
const P24 = /(24\s*(小时|h|H)|第\s*1\s*天|首日)/;
const P7D = /(7\s*(天|日|d|D)|168\s*(小时|h|H)|第\s*7\s*天)/;
const UNIT = /\d+(\.\d+)?\s*(小时|天|日|h|H|d|D|条|次|个|组|行|秒|分钟|年|月|号|周|期|名|位|倍|版|成|节|段|章|点|部分|遍|帧|字|元|镑)/g;
const THRESHOLD_BEFORE = /(达到|达线|达标|过|线|目标|≥|>=|超过|低于|不到|标准|门槛|破)\s*[（(]?\s*$/;

function periodsOf(text) {
  const has24 = P24.test(text), has7 = P7D.test(text);
  if (has24 && !has7) return ['24h'];
  if (has7 && !has24) return ['7d'];
  return null; // 两个都提到或都没提：不确定是哪个时间点
}

function allowedNumbers(work, periods, review) {
  const set = new Set();
  for (const p of periods || ['24h', '7d']) {
    const d = work.数据[p];
    if (Number.isInteger(d.播放量)) set.add(d.播放量);
    if (Number.isInteger(d.离达标线还差)) set.add(d.离达标线还差);
  }
  if (Number.isInteger(work['7天比24小时多'])) set.add(work['7天比24小时多']);
  return set;
}

export function checkReport(markdown, review) {
  const ids = review.作品.map(w => w.编号);
  const byId = Object.fromEntries(review.作品.map(w => [w.编号, w]));
  const idPattern = new RegExp(`(${ids.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![0-9])`, 'g');
  // 句子里提到某个平台、某个选题或「分组」时，里面的条数是分组条数，不和总数比（第一次测试里误判过）
  const groupWords = [...new Set(review.作品.flatMap(w => [w.平台, w.标题])), '分组'];
  const problems = [];

  markdown.split(/\r?\n/).forEach((rawLine, lineIndex) => {
    // 千分位 1,300 → 1300；中文全角数字不处理
    let line = rawLine.replace(/\*\*/g, '');
    while (/(\d),(\d{3})(?!\d)/.test(line)) line = line.replace(/(\d),(\d{3})(?!\d)/, '$1$2');
    const sentences = line.split(/[。！？!?]/);
    for (const sentence of sentences) {
      if (!sentence.trim()) continue;
      const sentencePeriods = periodsOf(sentence);
      let carried = null; // 句子里上一个分句提到的作品
      for (const clause of sentence.split(/[，,；;|]/)) {
        const clausePeriods = periodsOf(clause) || sentencePeriods;

        // 条数检查：有效 N 条、达线 N 条（只查总数）
        const aboutGroup = groupWords.some(g => sentence.includes(g));
        if (clausePeriods && clausePeriods.length === 1 && !aboutGroup) {
          const s = review.汇总[clausePeriods[0]];
          const mValid = clause.match(/有效(数据|作品)?\s*(\d+)\s*条/);
          if (mValid && Number(mValid[2]) !== s.有效条数) {
            problems.push({行: lineIndex + 1, 原文: rawLine.trim(), 问题: `${s.时间点}有效条数写成 ${mValid[2]}，数据是 ${s.有效条数} 条。`});
          }
          const mReached = clause.match(/达(到|线|标)[^，。；\d]{0,8}(\d+)\s*条/) || clause.match(/达(到|线|标)\s*\d{3,}\s*[^，。；\d]{0,6}(\d+)\s*条/);
          if (mReached && Number(mReached[2]) !== s.达线条数) {
            problems.push({行: lineIndex + 1, 原文: rawLine.trim(), 问题: `${s.时间点}达线条数写成 ${mReached[2]}，数据是 ${s.达线条数} 条。`});
          }
        }

        // 作品数字检查
        const text = clause
          .replace(/\d{4}-\d{1,2}-\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?Z?)?/g, ' ')
          .replace(/\d{1,2}-\d{1,2}/g, ' ')
          .replace(/\d{1,2}:\d{2}/g, ' ')
          .replace(/第\s*\d+(\s*[、,，和及与]\s*\d+)*/g, ' ')   // 第 3、4 节 这类序号
          .replace(/(\d+)\s*[–—~～]\s*(\d+)/g, '$2')            // 4–5 条 这类范围
          .replace(/(按|当成|当作|算作|视为|记为|填|为)\s*0(?![\d.])/g, ' ') // 「不按 0 算」这类说法（第一次重跑时误判过）
          .replace(UNIT, ' ');
        const respectively = /分别/.test(clause); // 「W01、W02 分别是 850、1000」：按顺序一一对应
        const tokens = [];
        idPattern.lastIndex = 0;
        const tokenRe = new RegExp(`${idPattern.source}|[A-Za-z]+\\d+|\\d+(\\.\\d+)?`, 'g');
        let m;
        while ((m = tokenRe.exec(text))) {
          if (ids.includes(m[1])) tokens.push({type: 'id', value: m[1]});
          else if (/^[A-Za-z]/.test(m[0])) continue; // R09、T101 这类编号
          else tokens.push({type: 'num', value: Number(m[0]), at: m.index});
        }
        let group = [];
        let lastWasNum = true;
        let nthAfterGroup = 0;
        for (const t of tokens) {
          if (t.type === 'id') {
            if (lastWasNum) { group = []; nthAfterGroup = 0; }
            group.push(t.value);
            lastWasNum = false;
            continue;
          }
          lastWasNum = true;
          let targets = group.length ? group : carried;
          if (respectively && group.length > 1 && nthAfterGroup < group.length) targets = [group[nthAfterGroup]];
          nthAfterGroup += 1;
          if (!targets || !targets.length) continue; // 没提到作品的数字不查
          if (t.value === review.达标线 && THRESHOLD_BEFORE.test(text.slice(Math.max(0, t.at - 8), t.at))) continue;
          for (const id of targets) {
            const allowed = allowedNumbers(byId[id], clausePeriods, review);
            if (!allowed.has(t.value)) {
              const when = clausePeriods ? clausePeriods.map(p => review.汇总[p].时间点).join('、') : '任何时间点';
              const shouldBe = [...allowed].join('、') || '没有可用数字（缺数、冲突或未到期）';
              problems.push({行: lineIndex + 1, 原文: rawLine.trim(), 问题: `${id} 在${when}没有 ${t.value} 这个数字。工具给的是：${shouldBe}。`});
            }
          }
        }
        if (group.length) carried = group;
      }
    }
  });

  if (!/待验证假设/.test(markdown)) {
    problems.push({行: 0, 原文: '', 问题: '报告缺少「待验证假设」部分。推测和小样本观察必须放在这一部分。'});
  }
  return problems;
}

// ---------- 统计表由代码生成 ----------
export function statsTable(review) {
  const cell = d => {
    if (d.状态 === '有效') return d.是否达线 ? `${d.播放量}（达线）` : `${d.播放量}（差 ${d.离达标线还差}）`;
    return d.状态;
  };
  const lines = [
    `| 编号 | 标题 | 平台 | 发布后 24 小时 | 发布后 7 天 |`,
    `|---|---|---|---|---|`,
    ...review.作品.map(w => `| ${w.编号} | ${w.标题} | ${w.平台} | ${cell(w.数据['24h'])} | ${cell(w.数据['7d'])} |`),
    '',
  ];
  for (const p of PERIODS) {
    const s = review.汇总[p.id];
    lines.push(`- ${s.时间点}：作品 ${s.作品总数} 条，有效 ${s.有效条数} 条，达线 ${s.达线条数} 条${s.达线作品.length ? `（${s.达线作品.join('、')}）` : ''}` +
      `${s.缺数作品.length ? `；缺数 ${s.缺数作品.join('、')}` : ''}${s.冲突需人工核查.length ? `；冲突需人工核查 ${s.冲突需人工核查.join('、')}` : ''}。`);
  }
  return lines.join('\n');
}

// ---------- 决定 5 + 6：保存报告（唯一出口） ----------
let failedAttempts = 0;
let rejectedProblems = [];
export function resetAttempts() { failedAttempts = 0; rejectedProblems = []; }

const listProblems = problems => problems
  .map(p => `- 第 ${p.行} 行：${p.问题}${p.原文 ? `\n  原文：${p.原文}` : ''}`)
  .join('\n');

function stamp() {
  const d = new Date(), z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

export function saveReport(markdown, {disputeNote, dataDir = DATA_DIR, outputDir = OUTPUT_DIR} = {}) {
  if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > 50000) {
    throw new ToolError('INVALID_ARGUMENTS', 'report_markdown 必须是不超过 5 万字的文字。');
  }
  if (disputeNote !== undefined && (typeof disputeNote !== 'string' || !disputeNote.trim() || disputeNote.length > 5000)) {
    throw new ToolError('INVALID_ARGUMENTS', 'dispute_note 必须是不超过 5 千字的文字，并写清楚争议在哪里。');
  }
  const review = buildReview(dataDir);
  const problems = checkReport(markdown, review);
  const header = `# 数据复盘报告\n\n> 统计截止时间：${review.统计截止时间} · 达标线：${review.达标线} · 生成时间：${new Date().toISOString()}\n\n## 统计表（由代码生成，AI 不改）\n\n${statsTable(review)}\n\n`;
  fs.mkdirSync(outputDir, {recursive: true});

  if (!problems.length) {
    // 被退回后才通过的报告，把退回记录留在报告末尾，让人能看出改过什么。
    const history = rejectedProblems.length
      ? `\n## 检查记录（由代码生成）\n\n这份报告第一次提交时被退回，修改后才通过。被退回的内容如下，请留意修改是否改变了原意：\n\n${listProblems(rejectedProblems)}\n`
      : '';
    resetAttempts();
    const file = path.join(outputDir, `复盘报告-${stamp()}.md`);
    fs.writeFileSync(file, `${header}## 解读（AI 写，已通过数字检查）\n\n${markdown.trim()}\n${history}`);
    return {已保存: true, 检查结果: '通过', 文件: path.relative(ROOT, file)};
  }

  if (disputeNote !== undefined) {
    resetAttempts();
    const file = path.join(outputDir, `待人工核查-复盘报告-${stamp()}.md`);
    fs.writeFileSync(file, `> ⚠️ AI 认为检查结果有争议，没有为了通过检查而改写，已转人工核查。\n\n**AI 的争议说明：**\n\n${disputeNote.trim()}\n\n**检查点提出的问题：**\n\n${listProblems(problems)}\n\n${header}## 解读（AI 写，有争议，未通过数字检查）\n\n${markdown.trim()}\n`);
    return {
      已保存: true, 检查结果: '有争议，已转人工', 问题: problems, 文件: path.relative(ROOT, file),
      下一步: '不要再改了。请在回复里告诉用户：报告已存为「待人工核查」版本，并说明争议在哪里。',
    };
  }

  failedAttempts += 1;
  if (failedAttempts < 2) {
    rejectedProblems = problems;
    return {
      已保存: false, 检查结果: '不通过', 第几次: failedAttempts, 问题: problems,
      下一步: '请逐条核对。确实写错的，改正事实后再调用一次 save_report，只用工具给的数字，不要自己算差值、比例或增长。如果你确认没有写错，不要为了通过检查而改写，请保持原文再调用一次 save_report，并在 dispute_note 里写明争议在哪里、依据是什么，报告会转人工核查。',
    };
  }
  resetAttempts();
  const file = path.join(outputDir, `待人工核查-复盘报告-${stamp()}.md`);
  fs.writeFileSync(file, `> ⚠️ 这份报告改了一次仍有数字对不上，已转人工核查。问题如下：\n\n${listProblems(problems)}\n\n${header}## 解读（AI 写，未通过数字检查）\n\n${markdown.trim()}\n`);
  return {
    已保存: true, 检查结果: '第 2 次仍不通过，已转人工', 问题: problems, 文件: path.relative(ROOT, file),
    下一步: '不要再改了。请在回复里告诉用户：报告已存为「待人工核查」版本，并列出对不上的地方。',
  };
}
