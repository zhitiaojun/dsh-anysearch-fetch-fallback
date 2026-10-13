/**
 * AnySearch → 直接抓取（浏览器 UA）的 fetch 回退：行为测试。
 *
 * 覆盖的关键路径：
 *   1. AnySearch 成功            → 原样返回，不触发回退
 *   2. AnySearch 422             → 回退直接抓取，返回其结果
 *   3. AnySearch 非 422 错误     → 原样抛出（不回退，避免掩盖真实故障）
 *   4. 官方 provider 缺席        → 直接抓取
 *   5. 回退抓取本身：浏览器 UA、体量上限、状态码语义、取消信号透传
 * 外加：错误包装链识别、`fetchProviderId` 的选择写入、热重载幂等、logger 崩溃隔离。
 *
 * 运行：npm test   （需先 npm run build）
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const mod = await import('../lib/index.js')
const {
  AnySearchFallbackProvider,
  BROWSER_USER_AGENT,
  FALLBACK_MAX_CHARS,
  FALLBACK_PROVIDER_ID,
  apply,
  directFetch,
  isUnextractable,
} = mod

// ───────────────────────── 测试替身 ─────────────────────────

const OK_RESULT = { url: 'https://example.com', statusCode: 200, body: { kind: 'text', content: 'anysearch-content' }, truncated: false }

/** 构造一个返回固定响应的 fetch 替身，并记录收到的请求。 */
function fakeFetch({ status = 200, body = 'fallback-body', contentType = 'text/html; charset=utf-8', url = 'https://example.com' } = {}) {
  const calls = []
  const impl = async (input, init) => {
    calls.push({ url: String(input), init })
    return {
      url,
      status,
      headers: new Headers(contentType === null ? {} : { 'content-type': contentType }),
      text: async () => body,
    }
  }
  impl.calls = calls
  return impl
}

/** 伪造一个上游 provider。 */
function fakeProvider(id, impl) {
  return { id, available: () => true, fetch: async (request, signal) => impl(request, signal) }
}

/** 伪造 AnySearch 客户端错误：带实例字段 httpStatus（对齐官方 AnySearchClientError）。 */
function anysearchError(httpStatus, message) {
  const error = new Error(message)
  error.name = 'AnySearchClientError'
  error.httpStatus = httpStatus
  return error
}

/** 伪造一个 ctx.web：provider 表可注入，并记录 registerFetchProvider 的调用。 */
function fakeCtx(providers = {}) {
  const registered = []
  const logs = []
  const ctx = {
    web: {
      fetchProviders: new Map(Object.entries(providers)),
      fetchProviderId: 'anysearch',
      registerFetchProvider(provider) {
        if (ctx.web.fetchProviders.has(provider.id)) {
          const error = new Error(`a web provider with id "${provider.id}" is already registered`)
          error.code = 'WEB_DUPLICATE_PROVIDER'
          throw error
        }
        registered.push(provider)
        ctx.web.fetchProviders.set(provider.id, provider)
        return () => ctx.web.fetchProviders.delete(provider.id)
      },
      async fetch(request, signal) {
        const provider = ctx.web.fetchProviders.get(ctx.web.fetchProviderId)
        if (provider === undefined) throw new Error(`no provider "${ctx.web.fetchProviderId}"`)
        return provider.fetch(request, signal)
      },
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  }
  return { ctx, registered, logs }
}

const REQUEST = { url: 'https://openai.com/index/introducing-chatgpt-images-2-5/' }
const REJECT_422 = () => { throw anysearchError(422, 'Unable to extract content from the URL.') }

// ───────────────────────── 1. 错误识别 ─────────────────────────

test('isUnextractable: 识别裸 422', () => {
  assert.equal(isUnextractable(anysearchError(422, 'Unable to extract content from the URL.')), true)
})

test('isUnextractable: 沿 cause 链识别被包装的 422', () => {
  const inner = anysearchError(422, 'Unable to extract content from the URL.')
  const wrapped = new Error('AnySearch extract failed: untrusted upstream error data', { cause: inner })
  const outer = new Error('web fetch failed', { cause: wrapped })
  assert.equal(isUnextractable(outer), true)
})

test('isUnextractable: 仅凭消息文本也能识别（无状态码字段时）', () => {
  assert.equal(isUnextractable(new Error('... Unable to extract content from the URL. (HTTP 422)')), true)
})

test('isUnextractable: 非 422 一律不识别', () => {
  assert.equal(isUnextractable(anysearchError(403, 'forbidden')), false)
  assert.equal(isUnextractable(anysearchError(500, 'boom')), false)
  assert.equal(isUnextractable(anysearchError(429, 'rate limited')), false)
  assert.equal(isUnextractable(new Error('fetch aborted')), false)
  assert.equal(isUnextractable(undefined), false)
  assert.equal(isUnextractable(null), false)
})

test('isUnextractable: cause 成环不死循环', () => {
  const a = new Error('a')
  const b = new Error('b', { cause: a })
  a.cause = b
  assert.equal(isUnextractable(a), false)
})

// ───────────────────────── 2. 回退行为 ─────────────────────────

test('AnySearch 成功：原样返回，不触发回退抓取', async () => {
  const fetchImpl = fakeFetch({ body: 'should-not-be-used' })
  const anysearch = fakeProvider('anysearch', () => OK_RESULT)
  const { ctx } = fakeCtx({ anysearch })
  const provider = new AnySearchFallbackProvider(ctx, () => {}, fetchImpl)

  const result = await provider.fetch(REQUEST)
  assert.equal(result.body.content, 'anysearch-content')
  assert.equal(fetchImpl.calls.length, 0, '回退抓取不应被调用')
})

test('AnySearch 422：回退直接抓取并返回其结果（本插件的缘起场景）', async () => {
  const fetchImpl = fakeFetch({ body: '<html>openai page</html>', contentType: 'text/html' })
  const anysearch = fakeProvider('anysearch', REJECT_422)
  const { ctx, logs } = fakeCtx({ anysearch })
  const provider = new AnySearchFallbackProvider(ctx, (m) => logs.push(m), fetchImpl)

  const result = await provider.fetch(REQUEST)
  assert.equal(result.body.content, '<html>openai page</html>')
  assert.equal(result.statusCode, 200)
  assert.equal(fetchImpl.calls.length, 1)
  assert.ok(logs.some((m) => m.includes('422')), '应记录回退日志')
})

test('回退抓取带浏览器 UA（否则 Cloudflare 站返回 403）', async () => {
  const fetchImpl = fakeFetch()
  const anysearch = fakeProvider('anysearch', REJECT_422)
  const { ctx } = fakeCtx({ anysearch })
  const provider = new AnySearchFallbackProvider(ctx, () => {}, fetchImpl)

  await provider.fetch(REQUEST)
  const headers = fetchImpl.calls[0].init.headers
  assert.equal(headers['user-agent'], BROWSER_USER_AGENT)
  assert.match(headers['user-agent'], /Mozilla\/5\.0/)
})

test('AnySearch 非 422（500）：原样抛出，不回退', async () => {
  const fetchImpl = fakeFetch()
  const boom = anysearchError(500, 'upstream exploded')
  const anysearch = fakeProvider('anysearch', () => { throw boom })
  const { ctx } = fakeCtx({ anysearch })
  const provider = new AnySearchFallbackProvider(ctx, () => {}, fetchImpl)

  await assert.rejects(() => provider.fetch(REQUEST), (e) => e === boom)
  assert.equal(fetchImpl.calls.length, 0, '非 422 不应回退')
})

test('AnySearch 非 422（403 无 key）：原样抛出', async () => {
  const fetchImpl = fakeFetch()
  const forbidden = anysearchError(403, 'invalid api key')
  const anysearch = fakeProvider('anysearch', () => { throw forbidden })
  const { ctx } = fakeCtx({ anysearch })
  const provider = new AnySearchFallbackProvider(ctx, () => {}, fetchImpl)

  await assert.rejects(() => provider.fetch(REQUEST), (e) => e === forbidden)
})

test('官方 provider 缺席：直接抓取（退化为通用抓取器）', async () => {
  const fetchImpl = fakeFetch({ body: 'direct' })
  const { ctx } = fakeCtx({})
  const provider = new AnySearchFallbackProvider(ctx, () => {}, fetchImpl)

  const result = await provider.fetch(REQUEST)
  assert.equal(result.body.content, 'direct')
  assert.equal(provider.available(), true, '无官方 provider 也应可用')
})

test('惰性解析：provider 在 fetch 之后才注册也能工作（无时序竞态）', async () => {
  const fetchImpl = fakeFetch({ body: 'fallback-used' })
  const { ctx } = fakeCtx({})
  const provider = new AnySearchFallbackProvider(ctx, () => {}, fetchImpl)

  // 构造之后、调用之前才出现官方 provider —— 模拟官方比本插件晚注册
  await new Promise((r) => setTimeout(r, 5))
  ctx.web.fetchProviders.set('anysearch', fakeProvider('anysearch', () => OK_RESULT))

  const result = await provider.fetch(REQUEST)
  assert.equal(result.body.content, 'anysearch-content', '应在调用时取到后注册的官方 provider')
})

// ───────────────────────── 3. 直接抓取本身 ─────────────────────────

test('directFetch: HTML 与非 HTML 的 body.kind 分类', async () => {
  const html = await directFetch({ url: 'https://x.test/' }, undefined, fakeFetch({ contentType: 'text/html; charset=utf-8' }))
  assert.equal(html.body.kind, 'html')

  const md = await directFetch({ url: 'https://x.test/a.md' }, undefined, fakeFetch({ contentType: 'text/markdown' }))
  assert.equal(md.body.kind, 'text')

  const json = await directFetch({ url: 'https://x.test/a.json' }, undefined, fakeFetch({ contentType: 'application/json' }))
  assert.equal(json.body.kind, 'text')

  // 无 content-type 时按 URL 扩展名推断
  const bare = await directFetch({ url: 'https://x.test/page.html' }, undefined, fakeFetch({ contentType: null }))
  assert.equal(bare.body.kind, 'html')
})

test('directFetch: 超长响应被裁剪并标记 truncated', async () => {
  const long = 'x'.repeat(FALLBACK_MAX_CHARS + 5000)
  const result = await directFetch({ url: 'https://x.test/' }, undefined, fakeFetch({ body: long }))

  assert.equal(result.truncated, true)
  assert.equal(result.body.content.length, FALLBACK_MAX_CHARS)
})

test('directFetch: 非 2xx 也返回结果而非抛错（状态码是资源状态）', async () => {
  const result = await directFetch({ url: 'https://x.test/missing' }, undefined, fakeFetch({ status: 404, body: 'not found' }))
  assert.equal(result.statusCode, 404)
  assert.equal(result.body.content, 'not found')
})

test('directFetch: 声明体量超过字节上限时提前拒绝', async () => {
  const impl = async () => ({
    url: 'https://x.test/big',
    status: 200,
    headers: new Headers({ 'content-type': 'text/plain', 'content-length': String(50_000_000) }),
    text: async () => 'x',
  })
  await assert.rejects(() => directFetch({ url: 'https://x.test/big' }, undefined, impl), /over the/)
})

test('directFetch: 调用方的取消信号透传', async () => {
  const controller = new AbortController()
  let seen
  const impl = async (_input, init) => {
    seen = init.signal
    return { url: 'https://x.test/', status: 200, headers: new Headers({ 'content-type': 'text/plain' }), text: async () => 'ok' }
  }
  await directFetch({ url: 'https://x.test/' }, controller.signal, impl)
  assert.ok(seen instanceof AbortSignal, '应传一个 signal 给 fetch')
  assert.equal(seen.aborted, false)
})

test('directFetch: 重定向后的最终 URL 被回填', async () => {
  const result = await directFetch({ url: 'https://x.test/old' }, undefined, fakeFetch({ url: 'https://x.test/new' }))
  assert.equal(result.url, 'https://x.test/new')
})

// ───────────────────────── 4. 装配与选择 ─────────────────────────

test('apply：注册 provider 并把 fetchProviderId 指向自己', () => {
  const anysearch = fakeProvider('anysearch', () => OK_RESULT)
  const { ctx, registered } = fakeCtx({ anysearch })

  apply(ctx)

  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, FALLBACK_PROVIDER_ID)
  assert.equal(ctx.web.fetchProviderId, FALLBACK_PROVIDER_ID)
})

test('apply 之后 web_fetch 在 422 时回退直接抓取', async () => {
  const anysearch = fakeProvider('anysearch', REJECT_422)
  const { ctx } = fakeCtx({ anysearch })

  const original = globalThis.fetch
  globalThis.fetch = fakeFetch({ body: 'rescued-by-fallback' })
  try {
    apply(ctx)
    const result = await ctx.web.fetch(REQUEST)
    assert.equal(result.body.content, 'rescued-by-fallback')
  }
  finally {
    globalThis.fetch = original
  }
})

test('apply 之后 web_fetch 命中 AnySearch 时不回退', async () => {
  const anysearch = fakeProvider('anysearch', () => OK_RESULT)
  const { ctx } = fakeCtx({ anysearch })

  apply(ctx)
  const result = await ctx.web.fetch(REQUEST)

  assert.equal(result.body.content, 'anysearch-content')
})

test('fetchProviderId 不可写时：告警但不抛（明确降级）', () => {
  const anysearch = fakeProvider('anysearch', () => OK_RESULT)
  const logs = []
  const ctx = {
    web: {
      fetchProviders: new Map(Object.entries({ anysearch })),
      registerFetchProvider() { return () => {} },
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  }
  Object.defineProperty(ctx.web, 'fetchProviderId', {
    get: () => 'anysearch',
    set: () => { throw new TypeError('readonly') },
    configurable: true,
  })

  assert.doesNotThrow(() => apply(ctx))
  assert.ok(logs.some((m) => m.includes('unable to set')), '应给出明确降级告警')
  assert.ok(logs.some((m) => m.includes('cordis.patch.yml')), '告警应包含手动兜底方案')
})

test('插件元数据：name / inject 正确', () => {
  assert.equal(mod.name, '@zhitiaojun/dsh-anysearch-fetch-fallback')
  assert.deepEqual(mod.inject, ['web'])
})

// ───────────────────────── 5. 回归测试（真实环境发现的两个 bug） ─────────────────────────

test('回归：重复 apply 不得抛 WEB_DUPLICATE_PROVIDER（热重载幂等）', () => {
  const anysearch = fakeProvider('anysearch', () => OK_RESULT)
  const { ctx } = fakeCtx({ anysearch })

  // 真实 dsh-web 的 registerFetchProvider 对重复 id 抛 WEB_DUPLICATE_PROVIDER，
  // 而 apply 会因 HMR / 禁用后重启而在同一进程内再次执行。
  apply(ctx)
  assert.doesNotThrow(() => apply(ctx), '第二次 apply 不应抛错')
  assert.doesNotThrow(() => apply(ctx), '第三次 apply 同样')

  const mine = [...ctx.web.fetchProviders.values()].filter((p) => p.id === FALLBACK_PROVIDER_ID)
  assert.equal(mine.length, 1, '同 id 只应保留一个注册')
  assert.equal(ctx.web.fetchProviderId, FALLBACK_PROVIDER_ID)
})

test('回归：logger 方法脱离宿主调用会抛错时，apply 不得崩溃', () => {
  // 复刻 cordis LoggerService 的行为：方法内部用 this，摘下来单独调用就抛
  // `TypeError: this is not a function`（真实环境实测到的崩溃）。
  const realLogger = {
    tag: 'logger-service',
    info(...args) {
      if (this === undefined || this.tag !== 'logger-service') throw new TypeError('this is not a function')
      return args
    },
    warn(...args) {
      if (this === undefined || this.tag !== 'logger-service') throw new TypeError('this is not a function')
      return args
    },
  }
  const anysearch = fakeProvider('anysearch', () => OK_RESULT)
  const { ctx } = fakeCtx({ anysearch })
  ctx.logger = realLogger

  assert.doesNotThrow(() => apply(ctx))
  assert.equal(ctx.web.fetchProviderId, FALLBACK_PROVIDER_ID, '仍应完成 provider 选择')
})

test('回归：logger 完全抛错时不得影响抓取', async () => {
  const exploding = {
    info() { throw new Error('logger exploded') },
    warn() { throw new Error('logger exploded') },
  }
  const fetchImpl = fakeFetch({ body: 'fallback-ok' })
  const anysearch = fakeProvider('anysearch', REJECT_422)
  const { ctx } = fakeCtx({ anysearch })
  ctx.logger = exploding

  const provider = new AnySearchFallbackProvider(ctx, (m) => {
    try { exploding.info(m) } catch { /* 吞掉，模拟 makeLogger 的保护 */ }
  }, fetchImpl)

  const result = await provider.fetch(REQUEST)
  assert.equal(result.body.content, 'fallback-ok')
})
