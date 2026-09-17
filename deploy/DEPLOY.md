# 单机容器部署

本服务使用 Docker Compose 部署，数据放在独立数据卷中。它只在服务器本机
`127.0.0.1:8787` 开放 HTTP，公网入口必须由已有的 HTTPS 反向代理接管。
客户端 Bearer Key 原样传给上游，不在服务器配置固定的生图 Key。

## 准备

- 一台能访问 `https://kkflow.org` 的 Linux 服务器，安装 Docker Engine 与
  Docker Compose 插件；服务器和用户需具备运行 Docker 的权限。
- 一个解析到服务器的域名、可用的 HTTPS 证书，以及 Nginx（或同等反向代理）。
  对外开放 443；证书签发如需 HTTP 验证，还需 80。不要对外开放 8787。
- 私有 GitHub 仓库的只读访问权限。不要把客户端 Key、管理员 Key、原图、
  `.env` 或 `data/` 上传到 GitHub。

## 从 GitHub 拉取

推荐给这一个私有仓库配置单独的只读 Deploy Key：

```sh
mkdir -p ~/.ssh && chmod 700 ~/.ssh
ssh-keygen -t ed25519 -f ~/.ssh/responses-image-bridge -N '' -C 'responses-image-bridge-deploy'
cat ~/.ssh/responses-image-bridge.pub
```

把最后一行输出的**公钥**添加到仓库 `Settings > Deploy keys`，不要勾选写入权限；
私钥只留在服务器，设置权限为 `600`。首次连接 GitHub 时核对 SSH 主机指纹。

```sh
chmod 600 ~/.ssh/responses-image-bridge
GIT_SSH_COMMAND="ssh -i $HOME/.ssh/responses-image-bridge -o IdentitiesOnly=yes" \
  git clone git@github.com:h614626370-del/responses-image-bridge.git
cd responses-image-bridge
```

## 首次启动

```sh
sh deploy/start.sh
```

第一次运行只生成权限为 `600` 的 `.env`，请检查上游地址、模型、请求超时等配置；
脚本会设置容器监听 `0.0.0.0:8787` 和管理页面的安全 Cookie。
随后再次运行：

```sh
sh deploy/start.sh
curl -fsS http://127.0.0.1:8787/healthz
docker compose exec bridge cat /app/data/admin-token.txt
```

最后一条命令只用于首次读取管理登录口令，不要贴到聊天、工单或日志中。
在 Nginx 的 HTTPS `server` 块中加入
[`deploy/nginx.conf.example`](nginx.conf.example) 的 `location /` 配置，
检查配置并重载 Nginx。公网验证 `https://你的域名/healthz`，
然后访问 `https://你的域名/admin/`。最好仅允许可信来源访问 `/admin/`。

客户端 Base URL 填 `https://你的域名`，勾选 Responses，填写客户自己的生图 Key。
先做一张图生图验证，再逐步加并发。客户端仍发 `gpt-5.5` 和流式请求；
带 Base64 原图且符合直连格式时，中间服务转为 `gpt-image-2` 的
`/v1/images/edits` 同步请求，并向客户端保持心跳、返回流式结果。
真实北熊请求格式尚未验证，若失败先按请求 ID 查看管理页面最近 12 小时记录。

## 更新与排错

更新会重建容器并中断正在生成的图片，建议在无任务时进行：

```sh
cd responses-image-bridge
GIT_SSH_COMMAND="ssh -i $HOME/.ssh/responses-image-bridge -o IdentitiesOnly=yes" git pull --ff-only
sh deploy/start.sh
```

```sh
docker compose ps
docker compose logs --tail=100 bridge
curl -fsS http://127.0.0.1:8787/healthz
```

`.env` 与 Docker 数据卷不在 Git 仓库中。数据卷保存管理口令、加密主密钥、
设置和最近 12 小时的诊断记录；请一起备份，不要只备份设置文件。
例如在项目根目录执行：

```sh
umask 077
docker compose exec -T bridge tar -C /app/data -czf - . > "bridge-data-$(date +%Y%m%d-%H%M%S).tgz"
```

切勿执行 `docker compose down -v`，否则会删除数据卷。
默认本地并发为空（不设限），大量高分辨率请求会占用内存；
如机器资源不足，可在 `.env` 设置 `MAX_CONCURRENT` 作为整个中间服务的保护上限，
并按实际负载调整。排错时不要把 Authorization、原图或包含 Key 的完整请求写入日志。
