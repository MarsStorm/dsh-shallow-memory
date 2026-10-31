# dsh-shallow-memory

给 [DSH](https://github.com/deepseek-ai) 的一层**浅层记忆**：有一点价值、但大概只热几天的小事，记下来，N 天没再提到就自己消失。

它要解决的是一对矛盾：上下文窗口很贵，但「他昨天说他最近不吃辣」这种事又不该被扔进长期记忆里占地方。于是单独开一层——**记录成本极低、存活时间有限、被再次提到就续命**。

```
深层  长期有效的身份、事实、规矩        （别的东西，比如 soul-md）
日记  叙述和感受，不设限                 （别的东西，比如你自己的日记本）
浅层  有一点价值但只热几天的小事        ← 这个插件
```

## 它怎么工作

- **每轮注入一小节**，节名 `shallow:memory`，order `0.55`（紧跟深层记忆之后）。没有条目时返回空串——**不产生任何注入噪音**。
- **每条都有 TTL**（默认 7 天）：
  - 同一件事再次被提到 → 刷新过期时间、`hits + 1`；
  - 超过 TTL 没被提到 → 从注入里消失，进 `expired` 尾巴（只留最近 20 条，方便回头抢救）。
- **自动续期**：入站消息是用户发的，正文里出现某条的 `key` 或 `tags`，就当「又提到了」，自动续期。消息 claim 发生在 prompt 组装之前，所以当轮就可见。
- **超量挤压**：超过 `maxEntries`（默认 12）条，或渲染超过 `maxChars`（默认 1400 字），按「最久没被提到」挤掉，被挤掉的标 `reason: capacity`。
- **快过期提示**：剩余 ≤ `warnDays`（默认 2）天时，行首加 `⏳`，提醒要么升级进深层记忆、要么放它走。

## 注入长什么样

```markdown
## 浅层记忆 · 自动过期（7 天没再提到就清掉；珍贵的东西要写进深层记忆）
- (剩 7 天 · 提过 3 次) 他最近在改记忆插件，手头这个叫 dsh-hierarchical-fishmemory
- (剩 1 天) 他说过不喜欢用 emoji 堆排场
```

## 安装

```bash
# 从 GitHub 装（把 <owner> 换成仓库作者）
dsh plugin --profile web add github:<owner>/dsh-shallow-memory

# 或者本地开发：把目录软链进 profile 的 node_modules，再在 profile 的
# cordis.patch.yml 里加一条 id: shallow-memory 的配置
```

> 装完/更新后如果你维护了 `restore-local.sh` 之类的本地补丁脚本，记得跑一次——`pnpm` 可能把 `@local/*` 软链剪掉。

## 配置

全部字段可选，写在 profile 的 `cordis.patch.yml` 里对应 `id: shallow-memory` 的那一段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `ttlDays` | `7` | 默认存活天数（1–365） |
| `warnDays` | `2` | 剩余几天开始标 `⏳` |
| `maxEntries` | `12` | 最多保留几条（超量的按最久未提挤掉） |
| `maxChars` | `1400` | 注入小节的字数上限（200–8000） |
| `order` | `0.55` | 注入节排序 |
| `storePath` | `$DSH_HOME/shallow-memory/store.json` | 存储文件位置，可写相对路径 |

## 工具

插件注册五个工具（也就是模型能调用的动作）：

| 工具 | 作用 |
| --- | --- |
| `shallow_note(text, key?, tags?, ttlDays?)` | 记一条。同 `key` 再记 = 刷新并 `hits + 1`；不传 `key` 时取正文前 16 字 |
| `shallow_touch(key \| id)` | 手动续期 |
| `shallow_list()` | 全部条目 + 最近被清掉的几条（要不要抢救的最后机会） |
| `shallow_forget(key \| id)` | 删掉一条（通常是在升级进深层记忆之后） |
| `shallow_sweep()` | 立刻清一次过期条目（平时每轮自动清，这个用于手动确认） |

## 存储

`$DSH_HOME/shallow-memory/store.json`，纯 JSON：

```json
{
  "version": 1,
  "entries": [
    {
      "id": "m1x2y3",
      "key": "不吃辣",
      "text": "他说最近胃不好，吃不了辣",
      "tags": ["辣", "胃"],
      "created": 1793400000000,
      "updated": 1793400000000,
      "hits": 2
    }
  ],
  "expired": []
}
```

坏 JSON 不会让插件崩——读失败就当空库。过期清理只改内存对象，落盘由调用方决定，所以中途抛错也不会写坏文件。

## 设计取舍

- **为什么不自动升级到深层记忆**：升级需要判断「这条到底重不重要」，那属于模型这次对话的判断，不属于插件的定时器。插件只负责把尾巴（`shallow_list` 里的「最近清掉的」）摆出来，让人有机会捞。
- **为什么默认 12 条 / 1400 字**：这是个「临时便签」的量级，多了就说明它承担了本该由长期记忆承担的事。这两个数都可以调。
- **为什么日志写 `mount.log`**：DSH 的插件加载失败常常是静默的（导入错误被吞掉），所以 `apply` 一进来就写一行 `mounted pid=...`。排查「它到底有没有被加载」时先看这个文件——空的就说明根本没跑起来。

## 开发

```bash
npm test        # 10 个纯逻辑单测，不依赖 DSH 运行时
```

`lib/core.js` 是纯逻辑（store 读写、过期、超量、渲染），不 import 任何宿主包，所以能离线测；`index.js` 只留 cordis 粘合层（注册注入节、五个工具、入站续期）。

## 许可

MIT，见 [LICENSE](./LICENSE)。
