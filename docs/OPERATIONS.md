# 部署与运维手册

当前版本使用独立 Node Worker、确认后研究的大纲流程，以及包含固定可信脚本的手册。工作流细节见 [工作流运维](SKILL-OPERATIONS.md) 与 [API 约定](API-CONTRACT.md#v2-skill-pipeline-additive)。升级或重启时同步处理 `api`、`worker` 和 `web`。

## 1. 架构和运维前提

```text
浏览器 → HTTPS 反向代理 → 127.0.0.1:7875 → Web Nginx / Vue
                                              │ /api
                                         NestJS API
                                              │
                                        PostgreSQL 16
                                              │
                                         Node Worker → 模型 / 搜索 / 公网页面
```

API/Web/数据库使用内部网络，只有 Worker 具有额外出站网络。

仓库提供配置模板与源码；部署者需自行准备服务器、DNS 和证书。容器使用指定大版本镜像；实际上线建议审查后固定具体补丁版本/镜像 digest，并制定安全升级节奏。不要直接更换 PostgreSQL 主版本来升级现有数据卷。

Compose 使用 `travelfolio_admin` 引导数据库，并通过 `deploy/postgres-init.sh` 建立非超级用户应用角色 `travelfolio`。`POSTGRES_PASSWORD` 仅用于引导管理员，`APP_DB_PASSWORD` 用于应用连接，两者分别生成；API 不接收管理员密码。应用角色可创建和迁移自己的表，不能创建数据库、角色或复制会话。更严格环境可再拆分只读写运行时角色和专用迁移角色。

初始化脚本仅对空数据目录执行。已有数据卷不会因修改 `.env` 自动变更角色或密码；数据库密码轮换要同时更新真实数据库角色凭据与应用配置。不要删除数据卷来“刷新密码”。[官方 PostgreSQL 镜像初始化说明](https://hub.docker.com/_/postgres)

Compose 通过健康检查和 `service_healthy` 管理启动依赖，但运行时依赖故障仍需监控和处理。[Docker 启动依赖说明](https://docs.docker.com/compose/how-tos/startup-order/)

## 2. 从本机升级到 HTTPS

1. 按 README 完成本机启动，确认管理员可登录
2. 准备自己控制的域名、DNS 和有效 TLS 证书，设置证书自动续期
3. 将 `deploy/nginx-https.conf.example` 按实际域名/证书路径配置到宿主机 Nginx。Web 保持回环绑定；只开放必要的 80/443，不开放 3000/5432
4. 将 `.env` 改为 `APP_ORIGIN=https://实际域名`、`SESSION_COOKIE_SECURE=true`。非标准端口需写入 Origin
5. 执行 `docker compose config --quiet`，然后 `docker compose up -d --build --force-recreate api worker web`
6. 对宿主机 Nginx 执行配置检查，再用该环境的标准命令重载。浏览器从最终 HTTPS 地址登录，检查 Cookie 的 HttpOnly/Secure 属性与刷新后的会话
7. 确认证书续期、HTTP 到 HTTPS 跳转、错误页面与日志。HSTS 仅在确认 HTTPS 长期可用后启用；不要未经确认加入 `includeSubDomains`

Nginx 需要保留浏览器看到的 Host 和 Origin。提供的代理示例保留 Host，并明确覆写转发头；API 不信任代理头。Secure Cookie 由明确环境变量控制，不取决于内部 HTTP 连接。若你增加 CDN、负载均衡器或更改端口，重新检查 Origin、代理信任、登录限流和健康检查。[Nginx 代理头文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)

不要把 `127.0.0.1` 绑定随意改成 `0.0.0.0` 来绕过 HTTPS；也不要启用全局 CORS 或跳过 CSRF 来解决配置错误。

## 3. 配置、管理员与用户

Compose 强制要求非空的数据库管理员密码、独立应用密码、加密主密钥及 Origin。`${VAR:?message}` 在缺值时阻止启动。注意 shell 中同名环境变量可能覆盖 `.env`；排查时只查看必要字段，避免泄漏整个解析后的配置。[Docker 变量插值说明](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)

创建管理员：

```sh
docker compose exec api node api/dist/admin-cli.js
```

重置已有用户密码（会撤销该用户已有会话）：

```sh
docker compose exec api node api/dist/admin-cli.js --reset
```

在可信终端中按提示输入；不把密码写入命令行参数或 shell 历史。没有邮件找回流程。仅向可信运维人员开放 Docker/宿主机权限，因为它等价于高权限数据访问。

管理员创建邀请码后仅显示一次，私下分享。停用账号用于停止该账号使用；它不自动退款、删除行程、撤销外部供应商 Key 或召回用户已经下载的导出文件。生产数据删除/保留策略应由运营者制定。

## 4. 日常检查

```sh
docker compose ps
curl --fail http://127.0.0.1:7875/api/health
docker compose logs --tail=100 api worker
```

健康端点只用于存活/数据库连通状态，不应包含账号、连接串或供应商密钥。API 健康不等于模型服务或搜索服务可用。管理员概览用于查看用户/行程数量、任务积压和脱敏失败摘要，不应当作完整审计系统。

日志使用有界轮转。示例 Nginx 关闭访问日志以减少记录行程 URL；如自行启用，应避免日志包含 Cookie、Authorization、请求正文、邀请码、API Key 或完整模型提示。应单独监控磁盘、数据库连接、内存、任务耗时、错误率和证书到期。

当前界面/API 为小规模使用设置读取上限：旅行列表为最近更新的 200 份，每份行程展示最近 200 个版本并始终额外包含当前采用版本，任务历史为最近 50 条。更旧记录仍在数据库中，不会因超过显示上限自动删除；这不是完整分页/档案检索功能。需要更大规模时，先实现分页与保留策略，不能依赖列表作为全量备份。

默认使用单个 API 实例和单个独立 Worker；多实例扩容和故障转移需要在目标环境另行验证。

## 5. 备份

数据库中含邮箱、行程、版本、任务、密码哈希、会话及加密后的用户 Key。备份按敏感数据处理，限制权限、加密保存到不同故障域，并设定适当保留期。不要把备份放在静态站点目录或源码 ZIP 内。

以下从当前容器中的 PostgreSQL 16 工具产生自定义格式快照：

```sh
umask 077
mkdir -p backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T postgres pg_dump -U travelfolio_admin -d travelfolio -Fc > "backups/travelfolio-${STAMP}.dump"
test -s "backups/travelfolio-${STAMP}.dump"
```

检查命令退出状态，并将备份按你的组织标准加密后异地保存；“文件非空”不证明能恢复。`pg_dump` 生成一致数据库快照，`-Fc` 由 `pg_restore` 恢复。[PostgreSQL 16 pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html)

加密主密钥 `KEY_ENCRYPTION_SECRET`、数据库配置及其他服务器秘密需要单独、加密、受限的恢复副本。数据库 dump 不包含运行环境里的主密钥。不要把主密钥与数据库明文备份一起放到公开或同一低权限位置。保留与备份对应的代码版本及镜像标识。

Worker 工作目录同样含私人行程及恢复文件，需要受限备份和保留策略；其运维细节见 [工作流运维](SKILL-OPERATIONS.md)。

## 6. 恢复演练：优先恢复到隔离副本

必须实际演练，以下步骤是操作说明，不代表已在你的基础设施验证。不要先对唯一生产数据卷执行清空操作。

1. 在隔离机器或独立 Compose 项目上启动 PostgreSQL，使用相同主版本；配置一个全新的空数据库
2. 不要同时启动 API：它会自动运行迁移。先恢复到空数据库
3. 使用可信备份，列出档案目录并恢复；不要恢复来自未知来源的 dump

对本项目的 PostgreSQL 服务，可使用一个独立演练数据库名：

```sh
# 仅新建隔离的演练库，不修改当前 travelfolio 数据库
# 如果该名字已存在，请选择新的名字，不要盲目覆盖
docker compose exec -T postgres createdb -U travelfolio_admin -O travelfolio -T template0 travelfolio_restore_check
cat backups/REPLACE_WITH_BACKUP.dump | docker compose exec -T postgres pg_restore --list > /tmp/travelfolio-restore-list.txt
cat backups/REPLACE_WITH_BACKUP.dump | docker compose exec -T postgres pg_restore -U travelfolio_admin --role=travelfolio -d travelfolio_restore_check --no-owner --no-acl --exit-on-error
```

恢复命令由管理员连接后切换到 `travelfolio`，以该应用角色创建恢复对象；因此不会意外把表全部恢复成管理员所有。不要省略 `--role=travelfolio` 后假定应用可以修改表。

然后使用与备份匹配的代码版本和加密主密钥，把**隔离 API 实例**的 `DATABASE_URL` 指向恢复库，配置隔离 Origin/端口，关闭外部生成访问和可选搜索。检查用户/行程/版本数量、普通账号所有权、导出、管理员访问及 Key 解密能力；不要未经许可真实调用用户的模型 Key。按需先撤销恢复副本中的旧会话，并确认生产与演练环境不会互相访问。

恢复成功之后再制定生产切换计划，暂停入口、备份现状、明确回退点。`pg_restore --clean`、`dropdb` 和 `docker compose down -v` 会删除数据，本手册不将其作为日常恢复步骤。[PostgreSQL 16 pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html)

## 7. 升级、迁移与回滚

1. 通知用户维护窗口，等待正在生成的任务结束或由用户取消
2. 记录当前代码/镜像版本，完成数据库与秘密备份，并确认恢复演练有效
3. 在隔离恢复副本上先运行新版本的 `npm ci`、类型检查、测试、构建和迁移
4. 备份后停止 API/Worker/Web，再更新已审核源码和镜像；启动时迁移先于 API 执行
5. 执行 `docker compose up -d --build --force-recreate api worker web`，检查健康、登录、生成、采纳、导出及普通用户隔离

数据库迁移按 `api/migrations` 记录；切勿编辑已经在生产执行的迁移来“修正”历史。迁移失败时先保存脱敏错误、停止重试式升级，并在备份副本诊断。不要只降级镜像并假定 schema 仍兼容。涉及不兼容变更时，回滚须同时恢复对应数据库、代码和密钥配置。

Compose 给 API 120 秒、Worker 30 秒的优雅关闭时间。Worker 通过 60 秒租约和心跳维护阶段执行权；数据库检查点和外部调用记录决定是否能安全恢复。可能已计费的调用不会自动重复，用户需要检查用量并明确确认恢复。详细规则见 [工作流运维](SKILL-OPERATIONS.md#recovery-and-billing)。

## 8. 常见排障

- **Compose 报缺少必填变量**：检查 `.env` 路径和值；不要把占位词当密钥。核对 shell 同名变量覆盖
- **登录后马上掉线/403**：核对浏览器 URL 与 `APP_ORIGIN` 完全一致；HTTP 本机用 `false`，HTTPS 用 `true`；清理过期 Cookie 后重试，不关闭 CSRF
- **429 登录限流**：等待窗口结束，检查同一反向代理后是否多人共用 IP 配额；不要信任任意转发头来规避
- **网页 502**：检查 API 与数据库健康、迁移日志。API 容器重建后应一起重建 Web，刷新 Nginx 的容器地址解析
- **Key 无法解密**：检查是否误换主密钥；恢复原密钥，或在计划内要求用户重新输入 Key。不要把旧密钥硬写进源码
- **模型 401/403/404/超时**：核对 provider、模型名称、端点兼容性、账户权限与费用；只向用户显示脱敏错误
- **“未经实时核验”**：这是未配置搜索或搜索没有提供有效证据的诚实状态；设置 Key 不保证供应商始终可用
- **任务失败/重启后中断**：查看状态，确认是否已生成候选版本；避免盲目重复生成造成费用
- **磁盘将满**：检查数据库、日志和备份占用；先确认恢复与保留策略，不直接删除数据卷

## 9. 发布包卫生

发布源码 ZIP 前运行构建/测试并记录结果；排除 `.env`、`node_modules`、数据库卷、备份、日志、证书、API Key、截图中私人数据等。必须包含 lockfile、迁移、配置示例、README 与运维/安全说明。未经授权不上传或发布代码到外部仓库，也不自动上线。

