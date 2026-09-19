# ---------------------------------------------------------------------------
# 《旅行青蛙·中国之旅》 NAS 容器
#
# 多阶段构建：builder 装依赖，runtime 只拷 node_modules + 源代码 + vendor/。
# 游戏源文件（vendor/）不在这里下载：请先在宿主机跑
#   node scripts/fetch-source.js
# 再 build（见 README「源获取与更新」）。这是刻意的——镜像里不该有
# 从网上抓来的第三方版权素材的获取逻辑。
# ---------------------------------------------------------------------------
FROM node:22-slim AS deps

WORKDIR /build
COPY package.json package-lock.json* ./
# devDependencies 里没有构建期必需项（测试用 node:test），所以只装生产依赖。
RUN npm install --omit=dev --no-audit --no-fund


FROM node:22-slim AS runtime

# 镜像元数据：本 NAS / Docker 移植版作者。
# 注意这里只声明"移植与容器化"这一层的作者——游戏本体与离线引擎的著作权
# 归 Hit-Point 与原离线版作者 Balticx，详见镜像内 /app/README.md 与游戏开屏声明。
LABEL org.opencontainers.image.title="旅行青蛙·中国之旅 NAS 版" \
      org.opencontainers.image.description="服务端权威的离线版移植：Docker 单容器网页应用 + 外部推送 + AI Skills" \
      org.opencontainers.image.authors="Kasbuky" \
      org.opencontainers.image.licenses="UNLICENSED (personal, non-commercial)" \
      org.opencontainers.image.version="1.0.4" \
      org.opencontainers.image.source="local build" \
      org.opencontainers.image.documentation="/app/README.md"

ENV NODE_ENV=production \
    PORT=8980 \
    FROG_DATA_DIR=/app/data \
    TZ=Asia/Shanghai

# tini 负责转发信号并回收孤儿进程，让容器的 SIGTERM 真正到达 node
# （server.js 收到后会把存档落盘再退出）。
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖先于源代码拷贝，改代码时不必重装依赖。
COPY --from=deps /build/node_modules ./node_modules
COPY package.json README.md ./
COPY src ./src
COPY public ./public
COPY skills ./skills
COPY scripts ./scripts

# 游戏本体与素材（由 scripts/fetch-source.js 生成，不进 git）。
COPY vendor ./vendor

# data/ 只建目录并交给命名卷；存档、配置、日志都在这里。
RUN mkdir -p /app/data/save /app/data/logs /app/data/cache \
    && chown -R node:node /app/data /app/vendor /app/src /app/public /app/skills

USER node

EXPOSE 8980

# 健康检查走免认证的 /api/health（同时会验证引擎是否真的起来了）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||8980,path:'/api/health',timeout:4000},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>process.exit(r.statusCode===200&&/\"engine\":true/.test(b)?0:1))}).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
