#!/usr/bin/env bash
# ===========================================================================
# 把 .fpk 里的 app.tgz 解出来，真把服务跑起来，打 HTTP 验证。
#
#   bash packaging/fnOS/scripts/verify-fpk.sh [path/to/xxx.fpk] [port]
#
# 不传参数则取 dist/ 下最新的 .fpk，端口默认 8980。
#
# 为什么值得做：
#   真机上"桌面图标点了没反应"最常见的两种原因是 (a) cmd/main 路径错、
#   (b) app 自身起不来。本机用托管 node 把【产物里的】server 跑一遍，
#   能提前把 (b) 类问题全部暴露——包括 vendor 素材缺失、data 目录不可写、
#   模块图断裂。剩下只有 (a) 类问题必须真机验。
#
# 注意：这里跑的是 Windows 版 node。JS 与 PNG/MP3 素材都是可移植的，
# 所以这个测试对 linux 产物有效；真机仍要再跑一次 trim-cli 验收。
# ===========================================================================
set -euo pipefail

export PATH="/usr/bin:/bin:/mingw64/bin:/c/Windows/System32:/c/Windows:${PATH:-}"

MANAGED_NODE="C:/Users/User/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
MANAGED_PY="C:/Users/User/.workbuddy/binaries/python/versions/3.13.12/python.exe"

NODE=""
for c in node "${MANAGED_NODE}"; do
    if [ -x "$c" ] 2>/dev/null || command -v "$c" > /dev/null 2>&1; then NODE="$c"; break; fi
done
PY=""
for c in python3 python "${MANAGED_PY}"; do
    if [ -x "$c" ] 2>/dev/null || command -v "$c" > /dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "${NODE}" ] || { echo "找不到 node" >&2; exit 1; }
[ -n "${PY}" ]   || { echo "找不到 python" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts/ -> fnOS/ -> packaging/ -> 仓库根，要退三层。
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

FPK="${1:-}"
if [ -z "${FPK}" ]; then
    FPK="$(ls -t "${REPO_ROOT}"/dist/*.fpk 2>/dev/null | head -n 1 || true)"
fi
[ -n "${FPK}" ] && [ -f "${FPK}" ] || { echo "找不到 .fpk，用法: verify-fpk.sh <path.fpk> [port]" >&2; exit 1; }

PORT="${2:-8980}"
WORK="${REPO_ROOT}/.build-verify"
# ⚠ 本机 shim 关掉了 MSYS 路径转换：把 /c/Users/... 直接交给原生 exe，
#   Windows 会理解成 C:\c\Users\...，于是"解包成功"但文件全进了幽灵目录，
#   表现是 node 报 MODULE_NOT_FOUND 而目录看起来又是好的。所有交给
#   python / node 的路径一律走 cygpath -w。
WORK_WIN="$(cygpath -w "${WORK}")"
# 重复跑时这里会删掉上次的 260MB 解包产物，本机沙箱会因此要求一次确认，
# 属于预期行为，放行即可。
rm -rf "${WORK}"
mkdir -p "${WORK}"

echo "==> 待验产物 : ${FPK}"
echo "==> 展开到   : ${WORK}   (Windows: ${WORK_WIN})"
"${PY}" - "$(cygpath -w "${FPK}")" "${WORK_WIN}" <<'PY'
import io, os, sys, tarfile
fpk, work = sys.argv[1], sys.argv[2]
if not os.path.isabs(work):
    sys.exit('解包目标不是绝对路径，会被解释成相对路径：%s' % work)
t = tarfile.open(fpk)
a = tarfile.open(fileobj=io.BytesIO(t.extractfile('app.tgz').read()), mode='r:gz')
a.extractall(work)
print('    解出 app.tgz -> %s' % work)
PY

APP_DIR="${WORK}/server"
DATA_DIR="${WORK}/data"
mkdir -p "${DATA_DIR}"
# 解包后立刻自证：文件必须在它该在的地方。就靠这一条挡住"幽灵目录"类事故。
[ -f "${APP_DIR}/src/server.js" ] || {
    echo "解包结果不对：${APP_DIR}/src/server.js 不存在。检查是否路径被解释到了别处。" >&2
    ls -la "${WORK}" >&2
    exit 1
}

echo "==> 启动服务 node=${NODE} port=${PORT}"
# 用与 cmd/main 完全相同的环境变量组合，避免"本机能跑真机不能跑"。
# 代理变量一并清掉：本机有系统代理，打 127.0.0.1 会被劫持到别的服务上，
# 症状是"连不上"或"返回了完全不相干的页面"。
TZ='Asia/Shanghai' NODE_ENV='production' PORT="${PORT}" HOST='127.0.0.1' \
    FROG_DATA_DIR="$(cygpath -w "${DATA_DIR}")" \
    http_proxy= HTTP_PROXY= https_proxy= HTTPS_PROXY= all_proxy= ALL_PROXY= \
    no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost' \
    "${NODE}" "$(cygpath -w "${APP_DIR}/src/server.js")" > "${WORK}/server.log" 2>&1 &
SRV_PID=$!
echo "    pid=${SRV_PID} 日志=${WORK}/server.log"

cleanup() {
    if kill -0 "${SRV_PID}" 2>/dev/null; then
        kill -TERM "${SRV_PID}" 2>/dev/null || true
        sleep 1
        kill -KILL "${SRV_PID}" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# ---- 等端口就绪 ------------------------------------------------------------
# ⚠ 不能用 `curl -o /dev/null`：`/dev/null` 在这里是**传给原生 curl.exe 的参数**，
#   而本机 shim 关闭了 MSYS 路径转换，curl 会去写一个不存在的 /dev/null，
#   报 `curl: (23) client returned ERROR on write` 并以非 0 退出——响应其实
#   已经拿到 200 了，但 `if curl ...` 永远判假，表现为"服务明明在监听却等不到"。
#   丢弃响应体请用 bash 自己的重定向 `> /dev/null`，那是 bash 处理的，不经过 curl。
ok=0
for _ in $(seq 1 40); do
    if curl --noproxy '*' -fsS --max-time 3 \
        "http://127.0.0.1:${PORT}/api/health" > /dev/null 2>&1; then
        ok=1; break
    fi
    if ! kill -0 "${SRV_PID}" 2>/dev/null; then
        echo "进程已退出，日志尾部：" >&2
        tail -n 25 "${WORK}/server.log" >&2 || true
        exit 1
    fi
    sleep 1
done
if [ "${ok}" != "1" ]; then
    echo "40 秒内 /api/health 未响应，日志尾部：" >&2
    tail -n 25 "${WORK}/server.log" >&2 || true
    exit 1
fi

# ---- 逐个打点 --------------------------------------------------------------
BODY="${WORK}/body.tmp"
BODY_WIN="$(cygpath -w "${BODY}")"
probe() {
    local path="$1" want="${2:-200}" code
    # -o 的目标同样要转 Windows 路径，理由同上。
    code="$(curl --noproxy '*' -s -o "${BODY_WIN}" -w '%{http_code}' --max-time 10 \
        "http://127.0.0.1:${PORT}${path}" 2>/dev/null || echo 000)"
    local size
    size="$(wc -c < "${BODY}" 2>/dev/null | tr -d ' ')"
    if [ "${code}" = "${want}" ]; then
        printf "    OK   %-28s %s  (%s bytes)\n" "${path}" "${code}" "${size}"
    else
        printf "    FAIL %-28s %s  (期望 %s)\n" "${path}" "${code}" "${want}"
        head -c 300 "${BODY}" 2>/dev/null | tr -d '\000'; echo
        return 1
    fi
}

echo "==> HTTP 打点"
fail=0
probe /api/health 200 || fail=1
probe /api/skills 200 || fail=1
probe /admin 200 || fail=1
probe / 200 || fail=1

# 首页必须真的把引擎脚本引进来（vendor 素材在不在，看这个最直接）
if ! grep -qiE '<script|egret|game' "${BODY}" 2>/dev/null && [ "${fail}" = "0" ]; then
    echo "    ⚠ 首页 body 里没看到脚本/引擎痕迹，人工确认一下 ${BODY}" >&2
fi

echo "==> 数据目录写入"
if [ -d "${DATA_DIR}/save" ] && [ -d "${DATA_DIR}/logs" ]; then
    echo "    OK   ${DATA_DIR}/save 与 /logs 已创建"
else
    echo "    FAIL 数据目录没有按预期初始化" >&2
    fail=1
fi

echo
if [ "${fail}" = "0" ]; then
    echo "==> 产物自跑通过：包里的 server 能起来、路由能响应、数据目录能写。"
    echo "    日志：${WORK}/server.log"
else
    echo "==> 产物自跑失败，详见上面输出与 ${WORK}/server.log" >&2
fi
exit "${fail}"
