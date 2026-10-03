# 实现依据与第三方许可

Vue3 + NestJS + PostgreSQL 应用外壳保留原创代码。v2 将以下 MIT 授权 Skill 的工作流、数据约束、编译/验收与主要交互迁移为 TypeScript，并保留原始许可与固定来源记录。未运行上游 Python/JS 脚本；不声称实现所有可选功能或像素级相同 UI。详见 SKILL-FEATURE-PARITY.md 与 upstream-skill/SOURCE-MANIFEST.json：

- https://github.com/TokenHungryMash/personalized-travel-guide-skill

生成的项目源码使用根目录 MIT 许可。npm 依赖分别适用各自许可，实际版本锁定在 package-lock.json；安装后可在 node_modules 中查看各包 LICENSE。源码 ZIP 不附带 node_modules，也不包含第三方照片或付费素材。

## 技术依据（2026-09-30 查阅）

- NestJS 安全头：https://docs.nestjs.com/techniques/security （本项目 Nest 11 使用 Helmet）
- node-postgres 事务：https://node-postgres.com/features/transactions
- PostgreSQL SELECT / FOR UPDATE / SKIP LOCKED：https://www.postgresql.org/docs/16/sql-select.html
- OpenAI Chat Completions：https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
- DeepSeek Chat Completion：https://api-docs.deepseek.com/api/create-chat-completion/
- Brave Search POST：https://api-dashboard.search.brave.com/api-reference/web/search/post
- PostgreSQL 容器：https://hub.docker.com/_/postgres

自定义服务需支持非流式 Chat Completions 和 JSON object 响应格式；不是所有标称“OpenAI 兼容”的接口都支持这些能力。模型名称、服务政策、费用和接口兼容性会变化，应按服务商当前文档核对。应用不会自动重试收费请求。


MapLibre GL、Sharp、Playwright 的实际版本/许可证由 package-lock.json 和对应安装包记录。OpenFreeMap/OpenMapTiles/OpenStreetMap 地图截图保留归属标记和来源/资源 hash；第三方图片必须保存精确来源，并人工检查使用许可与水印，不因可下载就推断可任意复用。
