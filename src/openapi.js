'use strict';
/**
 * The OpenAPI description of /api, generated from the same table the router is
 * built from where possible.
 *
 * It is written as data rather than annotations so that
 * test/unit/openapi-consistency.test.js can compare it against the live Express
 * router: every documented path+method must exist, and every implemented route
 * must be documented. That test is the reason this file cannot silently rot.
 */
const API_INFO = {
  openapi: '3.0.3',
  info: {
    title: '旅行青蛙 NAS 控制接口',
    version: '1.0.1',
    description: [
      '服务端权威的《旅行青蛙·中国之旅》离线版控制接口，供 AI Agent / 外部程序操作。',
      '所有动作都通过游戏原版协议转发给服务端引擎，因此规则（槽位类型、购买上限、',
      '招待次数、抽奖券消耗等）与游戏内完全一致。',
      '',
      '认证：`Authorization: Bearer <token>`，token 见 /admin 页面或 data/config.json。',
      '出错时返回 `{"error":{"code","message"}}`；游戏内部拒绝（例如三叶草没长好）',
      '返回 200 且 `ok:false`，因为这是正常结果而不是接口错误。',
    ].join('\n'),
  },
  servers: [{ url: '/api', description: '本机' }],
  components: {
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' }, message: { type: 'string' },
            },
          },
        },
      },
    },
  },
  security: [{ bearer: [] }],
};

/** path -> { method -> operation } */
const PATHS = {
  '/health': {
    get: {
      summary: '健康检查（免认证）',
      security: [],
      responses: { 200: { description: '服务与引擎状态' } },
    },
  },
  '/state': {
    get: {
      summary: '总览：蛙状态/三叶草/背包桌子/邮件/访客/券/图鉴进度',
      description: '刻意不返回蛙的目的地：那要等明信片寄回来。',
      responses: { 200: { description: '总览对象' } },
    },
  },
  '/harvest': {
    post: {
      summary: '收三叶草',
      description: '不传参数则收所有已长好的；也可传 {slot} 或 {slots:[]}。',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                slot: { type: 'integer' },
                slots: { type: 'array', items: { type: 'integer' } },
              },
            },
          },
        },
      },
      responses: { 200: { description: '{ok,harvested,fourLeaf,clover,cloverGained,results[]}' } },
    },
  },
  '/luggage': {
    get: { summary: '读背包（4 格：便当/护身符/工具/工具）', responses: { 200: { description: '槽位列表' } } },
    put: {
      summary: '装背包',
      description: '`{slots:{"1":itemId}}` 或 `{items:[itemId,...]}`；类型不符由引擎拒绝。',
      responses: { 200: { description: '{ok,ops[],bag[]}' } },
    },
  },
  '/table': {
    get: { summary: '读桌子（8 格）与“是否已备好”', responses: { 200: { description: '槽位列表' } } },
    put: { summary: '桌上放物', responses: { 200: { description: '{ok,ops[],table}' } } },
    delete: { summary: '清空桌子', responses: { 200: { description: '{ok,cleared}' } } },
  },
  '/shop': {
    get: {
      summary: '商店列表（含是否可买、是否买得起）',
      responses: { 200: { description: '{clover,count,items[],buyable[]}' } },
    },
  },
  '/shop/buy': {
    post: {
      summary: '购买',
      description: '`{shopId,qty}`（也可用 `{itemId}`，会自动换算成货架号）。',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['qty'],
              properties: {
                shopId: { type: 'integer' }, itemId: { type: 'integer' }, qty: { type: 'integer' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: '{ok,bought,clover,results[]}；买不了时 ok:false + message' },
        400: { description: '参数错误' },
      },
    },
  },
  '/visitor': {
    get: { summary: '当前访客（含偏好物品）', responses: { 200: { description: '{guest}' } } },
  },
  '/visitor/feed': {
    post: {
      summary: '招待访客',
      description: '`{visitorId,itemId}`；`{"auto":true}` 会自动挑它最爱的特产。',
      responses: {
        200: { description: '{ok,taste,reaction,ticketDelta}' },
        409: { description: '没有访客 / 已招待过 / 没有可喂的特产' },
      },
    },
  },
  '/lottery': {
    get: { summary: '抽奖状态（券、消耗、是否可抽）', responses: { 200: { description: 'lottery 对象' } } },
  },
  '/lottery/draw': {
    post: {
      summary: '抽奖（消耗 RAFFEL_NEEDTICKETS 张券）',
      responses: { 200: { description: '{ok,ball,rank,ticket}；券不够时 ok:false' } },
    },
  },
  '/mail': {
    get: { summary: '信箱列表（含未读）', responses: { 200: { description: '{total,unread,mails[]}' } } },
  },
  '/mail/claim': {
    post: {
      summary: '领取邮件奖励',
      description: '不传参数则领取所有未领取的；也可 `{id}` 或 `{ids:[]}`。',
      responses: { 200: { description: '{ok,claimed,gained,results[]}' } },
    },
  },
  '/collections': {
    get: {
      summary: '相册/特产/珍品/称号与进度',
      responses: { 200: { description: '{album,specialtys,handbook,achievements,progress}' } },
    },
  },
  '/skills': {
    get: { summary: '技能清单', responses: { 200: { description: '{count,skills[]}' } } },
  },
  '/skills/{name}': {
    get: {
      summary: '单个技能正文',
      parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: '{name,description,body}' }, 404: { description: '不存在' } },
    },
  },
  '/settings/push': {
    get: { summary: '读推送配置', responses: { 200: { description: 'push 配置' } } },
    put: { summary: '改推送配置（局部合并）', responses: { 200: { description: '{ok,push}' } } },
  },
  '/push/test': {
    post: { summary: '发送测试推送', responses: { 200: { description: '{ok,results[]}' } } },
  },
  '/logs/push': {
    get: {
      summary: '最近推送日志（默认 100 条）',
      parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
      responses: { 200: { description: '{entries[]}' } },
    },
  },
  '/logs/client': {
    get: {
      summary: '浏览器上报的日志（?log=1 时）',
      parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
      responses: { 200: { description: '{lines[]}' } },
    },
  },
  '/openapi.json': {
    get: { summary: '本文档', responses: { 200: { description: 'OpenAPI 3.0' } } },
  },
};

/** Routes that exist outside /api and are therefore not part of this document,
 *  listed so the consistency test can tell "not documented on purpose" from
 *  "forgotten". */
const NON_API_ROUTES = [
  'GET /', 'GET /index.html',
  'GET /resource/*', 'GET /resource/China/config/gameConfig.json',
  'GET /asset/postcard/:picId',
  'POST /__log',
  'GET /admin', 'GET /admin/*', 'POST /admin/login',
  'GET /skills/*',
  'GET /ws',
];

function buildOpenApi() {
  return { ...API_INFO, paths: PATHS };
}

/** Used by the consistency test to assert nothing here is undocumented. */
const DOCUMENTED = Object.entries(PATHS).flatMap(([p, methods]) =>
  Object.keys(methods).map((m) => m.toUpperCase() + ' ' + p));

module.exports = { buildOpenApi, PATHS, DOCUMENTED, API_INFO, NON_API_ROUTES };
