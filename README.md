# WeLink Native for Linux

非官方、实验性的 WeLink 桌面客户端原生移植工程。原生接口层、Linux 集成、构建工具和测试源码以 **MPL 2.0** 开源。

这不是华为官方 Linux 发行版，也不是新的 Web 聊天外壳。项目在 Linux 上实现原客户端使用的原生接口，并适配既有 Electron 前端。商业客户端、厂商 SDK、品牌资源和用户数据不包含在本仓库或本项目的公开更新包中。

## 代码与能力边界

- `LoginSecurity/`、`HttpBridge/`：登录、设备身份、TLS/HTTP 桥接。
- `MessagingFiles/`、`Contact/`：IM 传输、编解码、加密数据库、联系人、离线文件与桌面工具。
- `Conference/`：会议管理、媒体/窗口/权限适配及本地原生处理代码。
- `ImportExport/`、`Support/` 和根目录 C 文件：存储、导入导出和辅助接口。
- `NativeIntegration/`：实际 Electron 主进程/渲染进程桥接，不以成功空实现替代缺失功能。
- `NativeBuild/`：依赖获取、编译、原包补丁重建、镜像完整性和旁路更新工具。

当前验证基线是 HIT 定制的 WeLink 7.47.6 前端及 Electron 22.3.26 / Node 16.17.1 **Linux ia32 ABI**。已在 x86-64 GXDE/Debian 环境运行；不要把它理解为任意上游版本、ARM 或原生 Wayland 均受支持。会议服务的账号资格、服务端授权和真实会议质量不由本项目保证。

## 获取与更新

发行页：<https://github.com/jiwangyihao/welink-native-linux/releases>

本项目使用独立的原生构建版本 `r45.x`，与上游客户端版本分开。Linux 的“检查更新”只查询本仓库的稳定 Release，展示真实状态并在用户选择后打开对应发布页。**不会自动下载/执行 Windows `.exe`，也不会自动替换运行中的客户端。** 网络失败不等于“已是最新版本”。

r45.10 起，长发布说明只显示有界预览，避免把原生对话框按钮挤出屏幕；完整内容通过发布页查看。

r45.11 修正共享 HTTP 脚本在真实页面加载时的模块路径；r45.9 / r45.10 因启动回归已标记为预发布，不再参与稳定更新选择。

原生增量更新适用于 Release 说明中指定的既有基线。把安装器和 `install_desktop.py` 放在同一目录，按该版本说明核对 `SHA256SUMS`，再运行安装器的 `--activate`。安装器校验基线与全部目标文件，在新目录中发布镜像，保留旧版本和原账号目录。校验不通过会拒绝发布；不会用另一份账号或旧版 SDK 伪装成功。

公开资产只含本项目代码/原生构件、校验元数据和最小 copy/literal 增量。它们不是完整商业客户端。新的上游资源、模型、SDK 或字节码必须由构建者依法另行取得，不能通过改扩展名或套用本项目许可证来分发。

## 构建

见 [构建说明](docs/BUILD.md)。需要可信的、与补丁清单匹配的原始客户端输入；依赖版本与散列均固定。不要提交下载缓存或生成后的 `NativeIntegration/app-overrides/`。

```sh
python3 NativeBuild/prepare_overrides.py \
  --vendor-app /path/to/lawfully-obtained/resources/app \
  --output NativeIntegration/app-overrides
```

该步骤只重建私有工作目录中的适配文件，不执行原包。厂商输入不匹配时直接报错。镜像构建遵循 **prepare → 编译本镜像校验器 → finalize**，不可拿另一镜像的校验器混用。

## 验证

测试分为纯源码/协议测试、原生公开 ABI 回归、需要指定原始资源的隔离 Electron 场景，以及实机验收。没有原始资源或设备授权时，不能把缺失前提记作通过。CI 不使用工作账号或真实会议。

最近的本地基线验收覆盖了加密数据库查询、IPv4/IPv6 本地 TLS、窗口/协议唤醒、图片剪贴板和会议退出回执。生产企业会议、真实音视频质量、全部会话类型及每一种桌面合成器仍需各自验证。不要从一次无错误日志推导“所有功能完成”。

## 许可证与第三方材料

本项目自行编写的源码适用 [MPL 2.0](LICENSE)。这是文件级开源义务，不会把独立的商业原包或第三方组件变成本项目所有。

This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

第三方许可、补丁上下文和明确排除的材料见 [公开范围与第三方说明](PUBLICATION_SCOPE.md)。华为、WeLink、HIT 等名称/商标归原权利人，本项目不授予相关商标或原软件使用权。

## 安全与问题报告

- 不要在 issue、附件或 PR 中提交登录票据、token、手机号、聊天内容、数据库、录音、私钥或带鉴权参数的会议链接。
- 更新检查只需要公开的 GitHub 版本信息，不应携带 WeLink 账号身份或业务 token。
- 会议/录音/摄像头/麦克风权限必须由真实服务端状态和用户授权决定。
- 自定义 Electron 的缓存字节码兼容选项不是安全验证；只能执行已确认来源及散列的输入。

组织方式参考 [哔哩哔哩 for Linux](https://github.com/msojocs/bilibili-linux) 的原包适配、独立构建工具、GitHub Releases 和“检查 + 发布页手动安装”模式；没有复制它的更新实现。
