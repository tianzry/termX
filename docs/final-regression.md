# 收尾全应用最终回归（termX vs Netcatty）

- 日期：2026-11-06
- 被测：改名后的 `termx.exe`（debug 内嵌 dist，WebView2 CDP 9222，窗口 1402×902 / 125% 缩放）
- 对照：Netcatty 便携副本（独立 user-data-dir，CDP 9336，PrintWindow `PW_RENDERFULLCONTENT`）
- 证据目录：`G:\AiCode\termX\evidence`
  - 页面断言：`final-regression.json`（浅色/深色各 22 张截图）
  - 设置 8 tab 同尺寸并排：`pair/settings-*-sbs.png` + `pair/settings-pairs.json`
  - 首页 / SFTP 同尺寸并排：`pair/vault-hosts-sbs.png`、`pair/sftp-sbs.png`
- 方法：两窗 `SetWindowPos` 到同一请求尺寸 1240×840，PrintWindow 抓客户区，统一缩放并排；`termX` 页面走 CDP 真实事件（Radix tab 需 mousedown/mouseup），Netcatty 走 CDP 真实点击。

## 覆盖与结果

| 范围 | 浅色 | 深色 | 断言 |
|---|---|---|---|
| Vault 主机 | ✅ `final-light-page-hosts.png` | ✅ `final-dark-page-hosts.png` | 9 张主机卡、分组与搜索/工具栏正常 |
| Vault 监控 | ✅ | ✅ | 空态「一眼查看多台主机」，频率/范围控制台正常 |
| Vault 钥匙串 | ✅ | ✅ | 已存密钥 1 条（`id_ed25519`）、系统密钥 1 项、证书空态；Agent 显示 `early eof` |
| Vault 代理 | ✅ | ✅ | 空态 + 新建代理主按钮 |
| Vault 端口转发 | ✅ | ✅ | 0 条目 0 规则；托盘快捷开关置灰并写明原因 |
| Vault 脚本 | ✅ | ✅ | 分组/片段两节、F2 提示正常 |
| Vault 笔记 | ✅ | ✅ | 分组树 + 标题行 + 编辑/预览工具条 |
| Vault 已知主机 | ✅ | ✅ | 129 指纹卡、搜索/全部主机筛选 |
| Vault 日志 | ✅ | ✅ | 本轮自动化产生 SSH/本地/Telnet/串口记录，列表与详情入口正常 |
| SFTP 根面 | ✅ `final-light-surface-sftp.png` | ✅ | 双栏空态「先选择一个主机」，`nc-sftp-view` 存在 |
| 设置 8 tab | ✅ 每 tab 一张 | ✅ 每 tab 一张 | 应用/外观/终端/快捷键/SFTP/AI/同步与云/系统；AI `disabled=true` |
| SSH 129 | ✅ `final-light-term-ssh-129.png` | ✅ | 欢迎语 `Last login`，tab 绿点 |
| 本地 shell | ✅ `final-light-term-local.png` | ✅ | Git Bash 提示符，tab 绿点 |
| Telnet 2324 | ✅ `final-light-term-telnet.png` | ✅ | banner `TERMX-TELNET-OK`，tab 绿点 |
| 串口 COM1 | ✅ `final-light-term-serial.png` | ✅ | `serial_list_ports` 枚举 COM1，`serial_open` 成功、tab 绿点；无对端设备故无回显（不伪造） |

串口此前轮次报「拒绝访问」，本轮定位为上一实例未释放句柄；重启 `termx.exe` 后可稳定打开，串口断言见 `final-regression.json`（`terminals.serial.terminal.hasXterm=true`、`rowsText=""`）。

## 对照表（结论）

| 页面 | 结论 | 说明 |
|---|---|---|
| Vault 主机 | 一致 | 三栏布局、根 tab、底部设置、主机卡尺寸/圆角/状态点一致；数据量差异来自 Netcatty 隔离实例为空库 |
| Vault 监控 / 脚本 / 笔记 / 已知主机 / 日志 / 代理 / 端口转发 | 一致 | 信息架构与空态/工具条一致，详见上轮 #184–#215 与 `final-*-page-*.png` |
| 设置-应用 | 有意差异 | termX 版本 0.0.1，更新区明确「未接入 Tauri updater（缺签名公钥/endpoint/CI 产物）」并置灰；Netcatty 为 1.10.0 完整更新链路 |
| 设置-外观 | 一致 | 主题三段、强调色 12 列、字体/语言/透明度/预设一致 |
| 设置-终端 | 一致 | 字号 15px（Netcatty 14px，本机默认字号下的取值差异，已在上轮核对无观感影响）、行高/光标/键盘/行为分组一致 |
| 设置-快捷键 | 一致 | 方案切换、单键快捷键、标签栏限定、键帽列表一致 |
| 设置-SFTP | 一致 | 并发/覆盖策略/默认视图/压缩传输一致；「自动同步到远程」置灰（未实现） |
| 设置-AI | 有意差异 | termX 未移植 AI（Providers/Agents/Tool Access/Web Search/Safety），tab `disabled`，点击不切换 |
| 设置-同步与云 | 有意差异 | termX 将云同步放在 Vault「同步」页，设置页提供入口按钮；点击实测进入真实同步页（GitHub Gist / WebDAV / 本地快照），非占位 |
| 设置-系统 | 一致 | 数据目录 `~/.termX`、迁移报告、开机自启、代理模式一致；更新检查链路差异同「应用」 |
| SFTP 根面 | 一致 | 双栏 + 本地/远端浏览 + 空态；Netcatty 因历史标签自带本地浏览，属会话状态差异 |
| 终端渲染 | 一致 | xterm 同源，浅/深两套配色、tab 状态点、工具栏矩阵一致；本轮未做 Netcatty 同场景终端并排（其隔离实例无主机数据，新增主机会污染其用户数据） |
| 语言/术语 | 有意差异 | termX 默认简体中文（Netcatty 英文）；Vault 头「传输」对应 Netcatty「SFTP」 |

## 等级结论

- **P1 = 0**：无崩溃、无主流程阻塞、无数据丢失、无「点击无反应」的真实入口（同步入口已实测可用）。
- **P2（已知且有意/暂缓）**：AI 未移植；更新下载安装置灰；Windows ssh-agent 未运行（环境项，钥匙串已如实提示 `early eof`）。
- **P3**：串口无物理对端（COM1 可开、无回显）；设置窗口为应用内 overlay（#212 已决策不做独立窗口）；Netcatty 隔离实例空库导致内容不可逐条比对。
- **未验证**：真实 CA 证书握手、Windows ssh-agent 转发、真实串口设备回环、原生文件对话框；Netcatty 同场景终端并排（原因见上表）。
