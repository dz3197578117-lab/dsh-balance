/**
 * dsh-balance —— 常驻余额指示器（Host 半边）。
 *
 * 职责：
 * 1. 从 ctx.credentials 按引用名取各 provider 的 API key（值绝不离开本进程、绝不写日志）；
 * 2. 查询各 provider 的余额/可用性，结果缓存 60s；
 * 3. 在 Connection 的 fetch 注册表上注册同源只读路由 `/api/dsh-balance/summary`，
 *    供客户端半边（client/client.js）直接 fetch。
 *
 * 设计约束：只返回 JSON 可序列化的标量字段；任何异常都降级成 status，不让路由 500 掉整个面板。
 * @module dsh-balance
 */

export const name = 'dsh-balance'
export const inject = ['connection']

/** 客户端读取的同源只读路由。 */
const ROUTE = '/api/dsh-balance/summary'
/** 查询结果缓存时长（毫秒）。 */
const CACHE_MS = 60_000
/** 单个上游请求超时。 */
const TIMEOUT_MS = 8_000

/** 进程内缓存：{ at, payload } 或 { at: 0, pending: Promise }。 */
const cache = { at: 0, payload: undefined, pending: undefined }

function messageOf(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error
  return typeof error.message === 'string' ? error.message : String(error)
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function currencySymbol(currency) {
  if (currency === 'CNY') return '¥'
  if (currency === 'USD') return '$'
  return `${currency ?? ''} `
}

/** 按引用名依次尝试解析 key；进程环境变量优先由 credentials 自身分层处理。 */
async function resolveKey(ctx, refs) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined || typeof credentials.resolve !== 'function') return undefined
  for (const ref of refs) {
    try {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && hit !== null && typeof hit.value === 'string' && hit.value !== '') {
        return { key: hit.value, ref }
      }
    } catch (error) {
      // 单个引用解析失败不影响其它引用
    }
  }
  return undefined
}

/** 发一个 JSON 请求，返回 { status, body }；网络/超时异常向上抛。 */
async function requestJson(url, key) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text.slice(0, 200)
  }
  return { status: response.status, body }
}

function detailOf(body) {
  if (typeof body === 'string') return body
  if (body !== null && typeof body === 'object') {
    const message = body.message ?? body.msg ?? body.error
    if (typeof message === 'string') return message
    if (message !== null && typeof message === 'object' && typeof message.message === 'string') return message.message
    try {
      return JSON.stringify(body).slice(0, 160)
    } catch {
      return 'unparsable body'
    }
  }
  return String(body)
}

//#region providers

/** DeepSeek：官方余额接口。 */
async function queryDeepSeek(key) {
  const upstream = await requestJson('https://api.deepseek.com/user/balance', key)
  if (upstream.status !== 200) {
    return {
      status: upstream.status === 401 || upstream.status === 403 ? 'key-rejected' : 'error',
      detail: `HTTP ${upstream.status}: ${detailOf(upstream.body)}`,
    }
  }
  const infos = upstream.body?.balance_infos
  const info = Array.isArray(infos) ? infos[0] : undefined
  if (info === undefined) return { status: 'error', detail: '响应中没有 balance_infos' }
  const amount = Number(info.total_balance)
  return {
    status: 'ok',
    text: `${currencySymbol(info.currency)}${Number.isFinite(amount) ? amount.toFixed(2) : String(info.total_balance)}`,
    detail: `充值 ${info.topped_up_balance ?? '?'} / 赠送 ${info.granted_balance ?? '?'}`,
  }
}

const SENSENOVA_BASE = 'https://token.sensenova.cn'
const SENSENOVA_BALANCE_PATHS = [
  '/v1/user/balance',
  '/v1/balance',
  '/v1/dashboard/billing/subscription',
  '/v1/account/balance',
]

/** 商汤：网关未提供余额接口，退化为「密钥是否可用」探测。 */
async function querySensenova(key) {
  for (const path of SENSENOVA_BALANCE_PATHS) {
    let upstream
    try {
      upstream = await requestJson(`${SENSENOVA_BASE}${path}`, key)
    } catch {
      continue
    }
    if (upstream.status === 200) {
      const amount = Number(upstream.body?.total_balance ?? upstream.body?.balance ?? upstream.body?.data?.balance)
      return {
        status: 'ok',
        text: Number.isFinite(amount) ? `¥${amount.toFixed(2)}` : '已返回余额',
        detail: `${path}: ${detailOf(upstream.body)}`,
      }
    }
  }
  const probe = await requestJson(`${SENSENOVA_BASE}/v1/models`, key)
  if (probe.status === 200) return { status: 'no-endpoint', detail: '商汤网关没有余额接口（密钥可用）' }
  return {
    status: 'key-rejected',
    detail: `HTTP ${probe.status}: ${detailOf(probe.body)}`,
  }
}

const SU_BASE = 'https://new.ruiflux.sbs'

/** su 中继（New-API）：billing 接口只认面板访问令牌，sk- key 会被拒。 */
async function querySu(key) {
  const subscription = await requestJson(`${SU_BASE}/v1/dashboard/billing/subscription`, key)
  if (subscription.status === 200) {
    const limit = Number(subscription.body?.hard_limit_usd)
    const used = Number(subscription.body?.soft_limit_usd)
    const remaining = Number.isFinite(limit) && Number.isFinite(used) ? limit - used : undefined
    return {
      status: 'ok',
      text: remaining !== undefined ? `$${remaining.toFixed(2)}` : '已返回额度',
      detail: `额度 ${subscription.body?.hard_limit_usd ?? '?'} USD`,
    }
  }
  const probe = await requestJson(`${SU_BASE}/v1/models`, key)
  if (probe.status === 401) {
    return {
      status: 'key-rejected',
      detail: `${detailOf(probe.body)}（该 sk- key 当前不被中继接受）`,
    }
  }
  return {
    status: 'needs-panel-token',
    detail: `billing 接口需要面板访问令牌，sk- key 被拒：${detailOf(subscription.body)}`,
  }
}

/** 需要展示的 provider 列表。 */
const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek', refs: ['DEEPSEEK_API_KEY'], query: queryDeepSeek },
  { id: 'sensenova', label: '商汤', refs: ['DENGZHE_API_KEY', 'DENGZH_API_KEY'], query: querySensenova },
  { id: 'su', label: 'su 中继', refs: ['SU_API_KEY'], query: querySu },
]

//#endregion

async function collect(ctx) {
  const items = []
  for (const provider of PROVIDERS) {
    const resolved = await resolveKey(ctx, provider.refs)
    if (resolved === undefined) {
      items.push({ id: provider.id, label: provider.label, status: 'no-key', detail: `未配置 ${provider.refs.join(' / ')}` })
      continue
    }
    try {
      const result = await provider.query(resolved.key)
      items.push({
        id: provider.id,
        label: provider.label,
        keyRef: resolved.ref,
        ...result,
      })
    } catch (error) {
      items.push({ id: provider.id, label: provider.label, status: 'error', detail: messageOf(error) })
    }
  }
  return { updatedAt: Date.now(), items }
}

/** 带缓存与并发去重的汇总查询。 */
function summary(ctx) {
  const now = Date.now()
  if (cache.payload !== undefined && now - cache.at < CACHE_MS) return Promise.resolve(cache.payload)
  if (cache.pending !== undefined) return cache.pending
  cache.pending = collect(ctx)
    .then((payload) => {
      cache.payload = payload
      cache.at = Date.now()
      return payload
    })
    .finally(() => {
      cache.pending = undefined
    })
  return cache.pending
}

/**
 * 注册同源只读路由。
 * @param ctx - Host 上下文，需带 connection 服务。
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          try {
            return jsonResponse(200, await summary(ctx))
          } catch (error) {
            return jsonResponse(200, { updatedAt: Date.now(), items: [], error: messageOf(error) })
          }
        },
      }),
    'dsh-balance: balance summary route',
  )
}
