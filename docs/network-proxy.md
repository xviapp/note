# Android 应用内网络代理

页间 Android 内置 v2rayNG 的节点、订阅、路由规则、DNS、传输参数、自定义 Xray JSON、用户规则资源及配置备份界面。入口为「设置 → 网络代理 → 节点、订阅与完整配置」。仅安装页间，无需另装 v2rayNG。首次默认关闭；开启后随客户端启动，主界面与分享窗口共用一个核心。

开启后，手机的 WebView 联网请求及原生文件/APK 下载先进入内置 Xray，由路由规则选择直连、代理或阻止。包内页面、字体、脚本、本机文件和离线缓存继续本地读取。Cloudflare Worker 发起的 DeepSeek、arXiv 等请求仍在云端，不经过手机代理。应用外打开的浏览器沿用浏览器自己的网络。

核心启动失败、超时或退出后，客户端清除应用内 WebView 代理并让原生下载使用直连；右上角显示安静的感叹号，点击才展开原因、重试及配置入口。没有自动弹窗或 Toast。核心正常运行但某个节点连接失败，或规则选择阻止时，请求仍按规则失败，不自动直连。重试成功后恢复规则分流并清除故障标记。

配置仅保存在应用私有目录，复用 v2rayNG 的 MMKV；不加入笔记同步及笔记 ZIP 备份。原配置界面的独立备份/恢复保留。不要把含节点凭据或订阅地址的导出文件提交到 Git。

## 实现边界

- `android/v2ray/` 为固定版本的内置 Android library，包含原配置界面及核心配置生成能力，不产生独立应用。
- 系统 VPN/TUN、root/iptables、其他应用选择、按包名/UID 分流、局域网共享、开机接管、Tasker、磁贴、小组件、桌面快捷方式、外部配置链接、独立更新及推广的源码和资源已删除；仅保留 Proxy only 运行服务，无独立 Launcher。运行模式、监听地址、监听端口及认证由宿主控制；即使导入自定义 JSON，也只允许宿主的本地 SOCKS/HTTP 混合入口，原 DNS、出站和路由内容保留。
- `NoteProxyNetwork` 使用守护进程确认运行状态。WebView 的 `ProxyController` 生效后才放行首次客户端请求；原生下载显式指定该入口。应用不会修改系统代理或系统 VPN。核心出站流量不再次进入自己的入口。
- WebView 仍自行处理 HttpOnly Cookie、请求体、流式回复及 PDF Range，不通过 JS→原生 HTTP 缓冲转换。
- 开关仅在 note 设置中提供；配置页只保留连接诊断，编辑节点/规则仍可重载正在运行的核心。Android 前台服务保留低优先级静默通知，点击打开 note，不提供另一套启停操作。
- 配置页跟随 note 的白天、夜间、星空和系统主题，语言跟随当前中文宿主；不保存第二套主题、语言、动态配色设置。来源、核心版本和开源许可证收拢到「设置 → 关于页间」，不保留原独立关于页、翻译人员、社群与反馈入口。
- 旧备份里的系统模式、共享、监听端口、监听认证等设置不再影响运行；保留节点、订阅和有效路由/DNS 配置。包名/UID 条件仅保留备份格式兼容字段，常规配置生成和编辑界面不再使用。
- 本地入口仅监听 loopback；它不自动改变其他应用的流量，但 loopback 本身不是阻止其他应用主动使用该入口的访问控制机制。

## 来源与构建

源代码来自本工作区 v2rayNG commit `a4dd3d08de80958701247b00a8a979131192d1b4`，内置适配详见 `android/v2ray/README.md`。原 v2rayNG 目录保持不变。该模块保留 GPL-3.0 许可证。

构建使用 JDK 21、Android SDK Platform 37 / Build Tools 37、Gradle 9.8.0、AGP 9.4.1 和 Kotlin 2.4.20（完整配置界面的依赖要求）。安装最低版本仍为 Android 8.0，WebView 125+。首次构建下载固定版本 Xray AAR 与 GeoIP/GeoSite 数据，校验 SHA-256 后使用；后续使用本机缓存，二进制和生成文件不进入 Git。

```bash
npm run build:android
node scripts/android.mjs testDebugUnitTest
node scripts/android.mjs lintDebug
node scripts/android.mjs assembleDebug
```

隔离模拟器中的 `NoteProxyNetworkTest` 使用空白测试 Activity、本地 HTTP 服务和临时节点配置，覆盖 WebView/原生入口、HttpOnly Cookie、POST 请求体、Range 206、逐段流式响应、规则阻止、节点不可达、重复启动、重载、核心正常停止及进程突然退出后的降级与重试恢复，并核对系统代理未改变；不请求正式 API 或 AI 服务。调试包仅为这些本地测试地址允许明文 HTTP，正式包不包含测试 Activity 或测试网络配置。

2026-10-06 验证通过：TypeScript 检查、ESLint、客户端 29 项测试、Worker 109 项测试、离线构建 4 项测试、Android CLI 7 项测试、Android 单元测试、lint 和 APK 构建；Android 14 隔离模拟器上的上述网络集成测试通过。白天、夜间、星空主题已检查。APK 核对为单一宿主 Launcher、无 VPN/root 服务，包含四种 ABI 核心与 GeoIP/GeoSite 数据。真实订阅及公网代理节点尚未实测。

同日完成扩展精简后，再次通过客户端检查、29 项测试、Android 单元测试、lint 和构建，以及隔离模拟器 2 项集成测试。新增用例导入旧 VPN/root/共享/认证设置，核对普通 VLESS 配置只生成宿主管理的 loopback 入口、不生成包名/UID 条件，并能启动核心。APK 的 DEX 核对无已删除的系统代理、外部入口、独立更新与外观管理类。原生配置页的三种主题、note 关于页和许可入口也已验证。
