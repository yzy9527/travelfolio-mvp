# 前端测试指南

从仓库根目录运行。单元测试使用隔离测试数据，浏览器测试使用内存 PGlite 和合成演示账号；不访问生产数据库或调用付费模型与搜索。

## 常规检查

```sh
npm ci
npm run typecheck --workspace=@travelfolio/web
npm test --workspace=@travelfolio/web
npm run build --workspace=@travelfolio/web
```

执行完整 API / Web 检查使用 `npm run check`。CI 在 `main`、`feat/**` 分支推送和 pull request 时运行该命令，并验证源码 ZIP。

单元和 SSR 测试覆盖 API 客户端、Cookie / CSRF、错误处理、输入校验、来源 URL、手册渲染及模型字符串转义。它们不能证明真实浏览器排版、交互或部署环境已验证；以当前执行输出为准，不在源码中维护固定测试数量。

## 浏览器流程

需要能够正常启动并启用沙箱的 Chromium。将 `CHROMIUM_PATH` 设置为实际可执行文件的绝对路径。

`playwright-core` 已包含在项目依赖中。先构建前端，再运行测试：

```sh
npm run build -w web
CHROMIUM_PATH=/path/to/chromium node web/tests/browser-smoke.mjs
```

脚本启动临时 API 和生产构建页面，使用 `web/nginx.conf` 的实际 CSP。测试使用本机端口 3000 和 5173，运行前确认没有其他服务占用。

覆盖登录、向导草稿、重复生成、大纲刷新及精确确认、文件哈希校验、隔离 iframe、Trip Mode、移动预览、审阅和采用、版本冲突、回滚、取消、导出、设置及邀请管理。测试中的审阅勾选只验证界面流程，不代表真实内容核验。

## 独立手册交互

```sh
CHROMIUM_PATH=/path/to/chromium node --import tsx api/test/skill-runtime.browser.cjs
```

覆盖手册草稿编辑、顺序调整、恢复、整数金额分账、还款撤销、跨标签页冲突、320px 视口及沙箱内导航。使用合成手册，不修改已采用行程。

Chromium 无法启动时应检查安装、系统和容器的沙箱支持；不得将未运行的检查记为通过，也不要通过关闭浏览器沙箱制造通过结果。

## 产物与验证边界

浏览器流程成功后将截图、导出文件和 JSON 报告写入 `web/artifacts/`，该目录由 Git 和源码打包器排除。不要把真实用户内容或凭据放入测试产物。

部署前还需要在真实 PostgreSQL、Docker、浏览器及所选服务商环境中执行相应检查。合成测试不证明目的地事实、照片主体、地图准确性或服务商兼容性。
