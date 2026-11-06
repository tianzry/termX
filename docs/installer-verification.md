# 安装包验证（NSIS / MSI，2026-11-06）

- 版本：`termX 0.0.1`（`identifier com.termx.app`）
- 构建：`npm run tauri -- build`（release，非 debug；`bundle.targets = "all"`）
- 环境：Windows 11 x64，当前会话**非管理员**（无 UAC 提权）
- 证据目录：`G:\AiCode\termX\evidence`（`msi-install.log`、`msi-install-peruser.log`、`msi-admin-extract.log`、`installed-first-launch.png`、`installed-migration-system.png`）

## 产物

| 安装器 | 路径（相对 `src-tauri/target/release/bundle/`） | 大小 |
|---|---|---|
| NSIS | `nsis/termX_0.0.1_x64-setup.exe` | 12,025,955 B |
| MSI | `msi/termX_0.0.1_x64_en-US.msi` | 17,338,368 B |

两个产物均由同一次 release 构建产出；WiX（candle/light）与 NSIS 编译均无错误。

## NSIS 验证（全链路通过）

| 项目 | 结果 |
|---|---|
| 静默安装 `termX_0.0.1_x64-setup.exe /S` | exit 0 |
| 安装目录 | `%LOCALAPPDATA%\termX`（per-user，无需提权） |
| 安装文件 | `termx.exe` 42,654,720 B、`uninstall.exe` 79,238 B、`bin/` |
| 开始菜单快捷方式 | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\termX.lnk`（已创建） |
| 桌面快捷方式 | `%USERPROFILE%\Desktop\termX.lnk`（已创建） |
| 卸载注册项 | `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\termX`：DisplayName `termX`、DisplayVersion `0.0.1`、Publisher `termx` |
| 静默卸载 `uninstall.exe /S` | exit 0；快捷方式与注册表项均删除 |
| 卸载后 `~/.termX` | **保留**（数据目录不属于安装产物，卸载不删除；重装/升级继续使用） |

### 首次启动与旧 `~/.rssh` 迁移（隔离副本）

为避免触碰唯一真实数据，测试时把真实 `~/.termX` 原子重命名为 `~/.termX-hold-migration-test`，再用 hold 中的 `termx.db` 复制为 `~/.rssh/rssh.db`，然后启动安装版；测完删除测试目录并恢复真实 `~/.termX`。

| 项目 | 结果 |
|---|---|
| 迁移报告 | `status: "migrated"`、`mode: "rename"`（同卷原子重命名） |
| 数据核对 | tables `23/23`、rows `334/334`、recordings `0/0` |
| 旧目录 | `old_dir_removed: true`（`~/.rssh` 已清理） |
| 设置-系统展示 | 「已从 …\.rssh 迁移到 …\.termX（同卷原子重命名）；表 23 / 行 334 / 录制 0 个。旧目录已清理：是」 |
| 真实数据恢复 | `termx.db` 331,776 B、`termx.db-wal` 4,120,032 B、`snippets.json`、`recordings/`、备份均完整 |

### 卸载残留

- 卸载器移除 `termx.exe`、`uninstall.exe`、快捷方式与注册表项后，**留下** `%LOCALAPPDATA%\termX\termx.exe.WebView2\`（165 个文件，10,496,963 B）。
- 原因：WebView2 用户数据目录（浏览器进程缓存/配置）不由安装器注册为安装组件，卸载器不删；属于可重建缓存，不影响重装。
- 处置：记录后在测试机上手工删除 `%LOCALAPPDATA%\termX`，机器无残留。

## MSI 验证（构建通过；安装被权限阻塞）

| 项目 | 结果 |
|---|---|
| WiX 构建 | candle/light 通过，产出 `termX_0.0.1_x64_en-US.msi` |
| 静默安装 `msiexec /i … /qn /norestart` | **exit 1603**；日志 `Error 1925: You do not have sufficient privileges to complete this installation for all users of the machine` |
| per-user 覆盖 `ALLUSERS=2 MSIINSTALLPERUSER=1` | **exit 1603**；日志 `Error 1406: Could not write value URL Protocol to key \Software\Classes\ssh`（URL protocol 按 per-machine 写入 HKLM） |
| 管理员提权 | 未执行（当前非管理员会话，需交互式 UAC，测试不做自动提权） |
| 管理员安装解包 `msiexec /a … TARGETDIR=… /qn` | exit 0；payload 核对：`termx.exe` 42,654,720 B、`html2md.dll` 2,909,696 B、`bin/` |

### MSI 静态结构核对（安装表）

| 表 | 内容 |
|---|---|
| `Shortcut` | `termX.lnk` → `ApplicationProgramsFolder`（开始菜单）、`termX.lnk` → `DesktopFolder`（桌面）、`Uninstall termX.lnk` → `INSTALLDIR` |
| `Registry` | `Software\termx\termX`（InstallDir/快捷方式标记）；**HKLM** `Software\Classes\ssh`、`telnet`、`termx` URL protocol 及 `shell\open\command` |
| `Property` | `ALLUSERS=1`、`Manufacturer=termx`、`ProductName=termX`、`ProductVersion=0.0.1`、`ProductLanguage=1033`、`ProductCode={7099B5A9-A13C-4635-8519-67B893692239}`、`UpgradeCode={F1705ACF-9959-569D-8294-28539ABD9EDB}` |

**结论**：MSI 为 per-machine 安装（`ALLUSERS=1`，URL protocol 写 HKLM），必须管理员权限；当前环境无法完成安装/卸载实跑。安装目录、快捷方式、卸载残留、升级路径均**未实测**，仅静态表核对。NSIS 为 per-user 安装，二者作用域不同，可并存但会产生两份安装。

## 未验证 / 待人工

- MSI 管理员安装、卸载、快捷方式、`UpgradeCode` 升级路径（需 UAC 提权）。
- 安装版下的真实 CA 证书握手、Windows ssh-agent 转发、真实串口设备回环、原生文件对话框（与回归文档一致）。
