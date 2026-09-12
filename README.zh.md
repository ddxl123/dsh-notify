# dsh-notify-long

简体中文 | [English](README.md)

[![release](https://img.shields.io/github/v/release/ddxl123/dsh-notify-long?label=release&color=blue)](https://github.com/ddxl123/dsh-notify-long/releases)
[![test](https://img.shields.io/badge/tests-82%20passing-brightgreen)](https://github.com/ddxl123/dsh-notify-long)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）装上一双"耳朵"和一部"电话"：**任务做完、出错、需要你回答问题时，用系统提示音、桌面横幅和邮件提醒你**，不用一直盯着终端。

```
任务完成  →  🔔 系统提示音 + 桌面横幅 + 邮件「已完成：xxx」
需要选择  →  🔔 另一种提示音 + 邮件「需要你的输入：用哪个数据库？」
执行出错  →  🔔 警示音 + 邮件「错误：模型路由失败 …」
等待授权  →  🔔 提示音 + 邮件「需要授权：bash」
```

- **零运行时依赖**：只用 Node 内置模块，SMTP 客户端自己实现，不需要 `nodemailer`。
- **零构建步骤**：纯 JavaScript ESM，`git clone` 后直接装进 profile 就能用。
- **不会丢提醒**：每次提醒先落盘（durable outbox）再发送，失败自动退避重试；进程重启后继续投递。
- **不吵人**：同类事件去重、报错按指纹冷却、提示音突发合并、可设置免打扰时段（免打扰时只发邮件）。
- **可控**：可以在 `settings.yaml` 里热改路由（哪些事件走哪些通道），不用重启。

---

## 目录

- [安装](#安装)
- [配置](#配置)
  - [1. 邮件（推荐用 provider 预设）](#1-邮件推荐用-provider-预设)
  - [2. 密码放在哪里](#2-密码放在哪里)
  - [3. 生效与自检](#3-生效与自检)
  - [4. 免打扰与事件开关](#4-免打扰与事件开关)
- [提醒是怎么触发的](#提醒是怎么触发的)
- [模型可用的工具](#模型可用的工具)
- [完整配置参考](#完整配置参考)
- [常见问题](#常见问题)
- [开发](#开发)
- [设计取舍](#设计取舍)

---

## 安装

前提：Node.js ≥ 20.11，已经能运行 `dsh`（本插件用的是 web profile，也就是你现在的界面）。

> 当前版本通过 **GitHub 源码**分发（`v0.1.0`）；插件还没有发布到 npm，所以用下面的克隆方式安装。

```bash
git clone https://github.com/ddxl123/dsh-notify-long.git
cd dsh-notify-long
node scripts/install.mjs --profile web
```

脚本只做两件幂等的事：

1. 把本仓库软链到 `~/.dsh/profiles/web/node_modules/dsh-notify-long`
   （Cordis loader 用 profile 目录作为裸包名的解析锚点，所以必须链到这里）；
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加一行插件条目（保留文件里已有的内容）。

然后**重启 profile**：

```bash
dsh --profile web
```

> 说明：`cordis.patch.yml` 是热加载的，但新插件的**包**需要进程重新 import 才能注册工具，所以第一次安装要重启一次；之后改配置不用重启。
>
> 其它 profile（`headless` 等）：把 `--profile web` 换成对应名字即可；也可以 `node scripts/install.mjs --profile web --dry-run` 先看要做什么，用 `--uninstall` 卸载。

## 配置

配置有三层，越靠后优先级越高：

| 层 | 位置 | 用途 |
| --- | --- | --- |
| 组合条目 | `~/.dsh/profiles/web/cordis.patch.yml` 里的 `config:` | 装机时的默认值 |
| 设置文档（热更新） | `~/.dsh/settings.yaml` 的 `dsh-notify-long:` 段 | 日常调整，保存即生效 |
| 环境变量 | `DSH_SMTP_PASSWORD` 等 | 只放密钥 |

### 1. 邮件（推荐用 provider 预设）

在 `~/.dsh/settings.yaml` 里加一段：

```yaml
dsh-notify-long:
  email:
    preset: qq                 # 见下表，会自动填 host / port / 传输方式
    user: you@qq.com           # 登录账号
    from: "DSH <you@qq.com>"   # 发件人（一般和 user 相同）
    to: [you@qq.com]           # 收件人，可写多个
```

`preset` 可选：`qq`、`qq-exmail`、`163`、`163-enterprise`、`aliyun`、`gmail`、`outlook`、`office365`、`icloud`、`zoho`、`yahoo`、`sendgrid`、`mailgun`、`resend`、`brevo`。
也可以不用预设，直接写 `host` / `port` / `tls`（`implicit` = 465 端口直连 TLS，`starttls` = 587 端口升级 TLS，`plain` = 明文）。

常见坑：

- **QQ / 163 邮箱不能用登录密码**，要去邮箱设置里开启 SMTP 并生成「授权码」，把授权码当密码。
- Gmail 需要「应用专用密码」，普通密码会被拒。
- 465 端口超时会自动回退尝试 587 / 25（可用 `allowPortFallback: false` 关掉）。
- 默认 `requireTls: true`：绝不在明文连接上发送账号密码。

### 2. 密码放在哪里

三选一，按顺序查找（**不要把密码写进 git 仓库里的文件**）：

```bash
# ① 环境变量（推荐）：在 ~/.zshrc 里 export，或启动 dsh 前 export
export DSH_SMTP_PASSWORD='你的授权码'

# ② 组合/设置里的字面量（方便，但会明文落盘）
#    email: { pass: "..." }

# ③ 命令（从 Keychain / pass / 1Password CLI 取）
#    email: { passCommand: "security find-generic-password -s dsh-smtp -w" }
```

自带的自检脚本会读取同样的配置层，方便在重启前先验证：

```bash
node scripts/test-alert.mjs --channel email
node scripts/test-alert.mjs --channel sound --kind error   # 试听错误提示音
```

### 3. 生效与自检

装好并重启后，直接问 agent 就行：

> 用 notify_status 看看提醒配置对不对，然后 notify_test 全通道测一遍。

`notify_status` 会报告：启用了哪些通道、邮件是否可用（只显示主机/端口/发件人，**不显示密码**）、免打扰时段、队列里还有几条。

### 4. 免打扰与事件开关

```yaml
dsh-notify-long:
  quietHours:
    start: '23:00'
    end: '07:00'      # 免打扰期间：不出声、不弹横幅，但邮件照发
  alerts:
    channels: [sound, desktop, email]   # 全局通道
    kinds:
      completed: { enabled: true }
      question:  { enabled: true, channels: [sound, desktop, email] }  # 可按事件覆盖
      error:     { enabled: true }
      subagent:  { enabled: false }     # 子任务完成默认不提醒（噪音大）
  sound:
    perKind:            # 给不同结果配不同提示音
      completed: Glass
      error: Basso
      question: Ping
  desktop:
    titlePrefix: "[dsh]"   # 横幅标题前缀，多机时好区分
    sound: none            # 横幅自带音效；已经用 sound 通道就关掉，避免两声
```

## 提醒是怎么触发的

| 事件 | 触发时机 | 默认通道 | 通知内容 |
| --- | --- | --- | --- |
| `completed` | 一轮任务正常结束、会话回到空闲 | 全部 | 最后一段回复摘要 + 工具调用次数、失败次数、轮次 |
| `question` | agent 调用 `ask_user_question`（含 plan 审批） | 全部 | 问题正文 + 可选项 |
| `approval` | 需要你批准某个操作 | 全部 | 工具名 + 原因 |
| `error` | 一轮/一步失败，或会话级错误 | 全部 | 失败原因（带错误码），按指纹 10 分钟冷却 |
| `subagent` | 子 agent 结束（默认关闭） | 关闭 | 子任务最终输出 |
| `manual` | 模型主动调用 `notify_user` | 全部 | 自定义标题/正文 |
| `test` | `notify_test` 自检 | 全部 | 通道逐项结果 |

判定细节：

- **同一轮只提醒一次**：这一轮如果已经因为"提问/授权/报错"提醒过，会话回到空闲时不会再补一条"完成"。
- **空轮不提醒**：没有执行任何步骤、没有回复的轮次（例如空输入被取消）直接跳过。
- **子会话不打扰**：subagent 子会话默认不算"任务完成"；要收就把 `subagent.enabled` 打开。
- **不打断执行**：所有投递都在后台进行，失败只记录日志，绝不抛回 agent 循环。

## 模型可用的工具

| 工具 | 作用 |
| --- | --- |
| `notify_user` | 主动提醒你（标题 + 正文 + `urgency`：`info` / `action` / `error`，可指定 `sound`）。适合长时间的无人值守任务。 |
| `notify_test` | 逐通道自检，返回每个通道的真实结果与失败原因。 |
| `notify_status` | 报告通道启用状态、邮件是否可用（脱敏）、免打扰、队列长度、本次运行成功/失败数。 |
| `notify_flush` | 立刻重试队列里所有待发提醒（例如刚把邮件密码改对）。 |

工作目录：`~/.dsh/dsh-notify-long/`

- `outbox.json` — 待发提醒队列（原子写入；成功即删除，最多重试 5 次，超过 6 小时未送出则丢弃）；
- 想看状态直接问 agent 要 `notify_status`。

## 完整配置参考

所有字段都可以省略（括号内为默认值）。

```yaml
dsh-notify-long:
  enabled: true                # 总开关

  sound:
    enabled: true
    file:                      # 全局音频文件（留空按事件自动选；macOS 可写 Glass / Basso …）
    player:                    # 播放器（默认 afplay；Linux: paplay/pw-play/aplay/ffplay）
    perKind: {}                # 事件 → 音频文件/名称
    timeoutMs: 10000

  desktop:
    enabled: true
    titlePrefix:               # 横幅标题前缀
    sound:                     # macOS 横幅音效名；填 none 关闭

  email:
    enabled: true
    preset:                    # qq / gmail / outlook / sendgrid …（自动填 host/port/tls）
    host:                      # SMTP 服务器
    port: 465
    tls:                       # implicit | starttls | plain（默认按端口推断）
    user:                      # 登录账号
    pass:                      # 字面量密码（不推荐）
    passEnv: DSH_SMTP_PASSWORD # 密码所在的环境变量名
    passCommand:               # 取密码的命令（stdout 即密码）
    from:                      # 发件人，支持 "名字 <地址>"
    to: []                     # 收件人（字符串或数组）
    cc: []
    subjectPrefix: "[DSH]"
    html: true                 # 是否附带 HTML 版本
    requireTls: true           # 明文连接上绝不发送凭据
    verifyCert: true           # 校验服务器证书
    preferPlain: true          # 优先 AUTH PLAIN（否则 LOGIN / CRAM-MD5）
    allowPortFallback: true    # 端口不通时尝试 465/587/25 中的其它端口
    heloName:                  # EHLO 名，默认本机主机名
    timeoutMs: 20000

  quietHours:
    start:                     # 'HH:MM'
    end:                       # 'HH:MM'（跨零点自动识别，如 23:00 → 07:00）

  alerts:
    channels: [sound, desktop, email]
    dedupeWindowMs: 300000     # 同一事件 5 分钟内只提醒一次
    errorCooldownMs: 600000    # 同指纹报错 10 分钟冷却
    channelCooldownMs: 15000   # 提示音突发合并窗口
    kinds: {}                  # { completed|question|approval|error|subagent|manual|test: { enabled, channels } }

  outbox:
    path:                      # 默认 ~/.dsh/dsh-notify-long/outbox.json
    flushOnStart: true         # 启动时补发积压提醒

  tools:
    enabled: true              # 是否注册 notify_* 工具

  log:
    delivered: true            # 记录投递日志

  debug: false                 # 输出调试信息（状态目录、队列恢复情况）
```

## 常见问题

**改了配置没反应？**
`settings.yaml` 是热生效的；`cordis.patch.yml` 里的 `config` 改动需要重启。用 `notify_status` 确认当前生效值。

**没有声音？**
`node scripts/test-alert.mjs --channel sound` 会打印实际执行的命令。macOS 需要 `/System/Library/Sounds/*.aiff`（系统自带）；Linux 需要 `paplay` / `pw-play` / `aplay` / `ffplay` 之一；容器/远程环境通常没有音频设备，此时请用邮件通道。

**邮件发不出去？**
`notify_status` 看 `email` 一行是否 `ready`；失败原因会写进 `notify_flush` 的返回和日志。常见原因：用了登录密码而不是授权码、465 被防火墙挡（试 `port: 587` + `tls: starttls`）、发件人和登录账号不是同一个域、服务器证书自签名（可临时 `verifyCert: false`）。

**提醒重复/太吵？**
调大 `alerts.dedupeWindowMs`；用 `alerts.kinds.subagent.enabled: false` 关掉子任务；用 `quietHours` 设定免打扰时段。

**会不会拖慢 agent？**
所有通道都是异步子进程/网络调用，且有超时上限；任何一个通道挂掉都不会影响对话，失败会进队列重试。

## 开发

```bash
node --test test/          # 82 个测试：策略、渲染、SMTP（本地假服务器）、队列、引擎、profile 补丁编辑、boot 级挂载
node scripts/test-alert.mjs --channel all --json
```

目录结构：

```
src/index.js              Cordis 插件入口：读服务、订阅事件、注册工具（薄接线层）
lib/core/                 与 harness 无关的决策层：策略、文本、事件折叠、队列、引擎、profile 补丁编辑
lib/channels/             三个投递通道：系统提示音、桌面横幅、邮件
lib/email/                自研 SMTP 客户端 + RFC 5322/MIME 构造
lib/runtime/handlers.js   harness 事件 → 提醒决策（纯函数，便于测试）
scripts/install.mjs       幂等安装/卸载
scripts/test-alert.mjs    脱离 harness 的通道自检
test/                     单元测试 + 假 SMTP 服务器 + 假 harness 挂载测试
```

## 设计取舍

- **为什么不做成动态 Cordis 插件？** 动态插件活在单个会话/进程内存里，重启即消失，而且权限受限；"任务完成提醒"必须对所有会话、重启后依然有效，所以它是一个真正的 npm 插件包，装在 host 侧组合里。
- **为什么自己写 SMTP？** 本插件承诺零运行时依赖：不需要 `npm install`、不受传递依赖影响，SMTP 提交所需的子集（EHLO/STARTTLS/AUTH PLAIN/LOGIN/CRAM-MD5/MAIL/RCPT/DATA）只有几百行，且全部有测试覆盖。
- **为什么先落盘再发送？** 提醒的意义在于"一定会到达"。先写 `outbox.json`，成功才删除；断网、重启、关机都不会吞掉一条"任务完成了"。

---

如果你的 agent 在深夜跑长任务，这个插件就是替你在键盘前守着的那只耳朵。MIT License.
