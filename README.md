# 火车票短视频数据复盘 Harness

这个仓库保存修改后的 DeepSeek Harness 配置、规则和复盘工具。

## 主要文件

| 文件 | 作用 |
|---|---|
| `02-加Harness/.agents/skills/video-review/SKILL.md` | 复盘流程、规则和报告格式 |
| `02-加Harness/cordis.patch.yml` | 当前配置，已开放运行命令和读写文件 |
| `02-加Harness/cordis.patch.最小权限版.yml` | 开放权限之前的配置 |
| `02-加Harness/工具/` | MCP 服务、复盘计算、报告检查和自动测试 |
| `02-加Harness/数据/` | 测试数据和复盘设置 |
| `01-基线测试-无Harness/复盘报告.md` | 自动测试用到的基线报告 |

## 使用前

把两个配置文件里的 `/path/to/02-加Harness` 改成本机路径，然后启动：

```bash
dsh web --patch /path/to/02-加Harness/cordis.patch.yml
```

运行测试需要 Node.js：

```bash
cd 02-加Harness
node --test 工具/tools.test.mjs
```
