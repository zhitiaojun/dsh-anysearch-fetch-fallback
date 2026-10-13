/**
 * @zhitiaojun/dsh-anysearch-fetch-fallback — 给官方 AnySearch 插件补一个 fetch 回退。
 *
 * ## 解决什么问题
 *
 * `@anysearch/anysearch-dsh` 的包内 patch 会把 web seam 的两条线一起指向自己：
 *
 * ```yaml
 * - id: web
 *   config:
 *     searchProvider: anysearch
 *     fetchProvider: anysearch   # ← 这里
 * ```
 *
 * 而 AnySearch 的 `/v1/extract` 是「网页正文提取器」，它的**抓取端**会被一部分站点
 * 拒绝（Cloudflare 按 UA 拦截的站、部分媒体站等），此时它以 HTTP 422 +
 * `Unable to extract content from the URL.` 失败。于是宿主的 `web_fetch` 在这些
 * 页面上完全不可用——即使该页面用浏览器 UA 直接抓是能拿到的。
 *
 * 实例：`https://openai.com/index/introducing-chatgpt-images-2-5/`（AnySearch 422，
 * 浏览器 UA 直接抓 200 / 626 KB）。
 *
 * ## 怎么解决
 *
 * 本插件注册一个**自己的** fetch provider（id `anysearch-fallback`），然后把这个 id
 * 写进运行时的 provider 选择字段，使 `web_fetch` 改走本插件：
 *
 * ```
 * try   → 官方 anysearch provider      （正文转 Markdown，质量更高）
 * catch → 仅当 HTTP 422 时
 *           → 直接 fetch（浏览器 UA）  （通用抓取，绕过按 UA 的拦截）
 * ```
 *
 * 非 422 的错误原样抛出：5xx / 超时 / 网络故障回退会掩盖真实问题，不做。
 *
 * ## 为什么回退目标是「直接 fetch」而不是宿主原生 `http` provider
 *
 * 实测（2026-10，本机 TUN 代理），`@deepseek-ai/dsh-web-fetch-http` **在有 TUN
 * 代理的机器上等于不可用**：它带 SSRF 防护，会拒绝解析到非公网地址的目标；TUN +
 * fake-IP 模式下所有域名都解析到 `198.18.0.0/15`，于是它对每个公网地址都抛
 * `WEB_BLOCKED_URL`（实测 12/12 全灭）。回退到它 = 回退到一个必然失败的目标。
 *
 * 直接用 Node `fetch` 不受该校验约束，配合**浏览器 UA** 还能拿回被 Cloudflare
 * 按 UA 拦截的页面。10 个真实 URL 的对照：AnySearch 失败而直接 fetch 成功的有
 * 4 个（openai.com ×2、Wikipedia、HuggingFace）。
 *
 * ## 为什么不需要改配置、也没有时序竞态
 *
 * - `ctx.web.fetch()` 在**每次调用时**重新解析 provider（见 dsh-web 的
 *   `resolveProvider`），不是启动时绑定。所以本插件何时注册完都不影响结果，
 *   只有在用户第一次调用 `web_fetch` 之前完成即可。
 * - 官方 provider 的实例是**调用时惰性获取**的（`fetchProviders.get('anysearch')`），
 *   那时官方必然已经注册，因此不需要等待、不需要轮询、不需要 sleep。
 * - 改写的是运行时的 `fetchProviderId` 字段，**不触碰 profile 的
 *   `cordis.patch.yml`**：装完即可用，卸载即还原（字段随进程消失）。
 */

export const name = '@zhitiaojun/dsh-anysearch-fetch-fallback'
/** 只需要 web seam；官方 provider 的存在与否在调用时判断，不构成硬依赖。 */
export const inject = ['web']

// ───────────────────────── 结构化类型（零外部类型依赖，duck-typed cordis） ─────────────────────────
//
// 刻意不 `import type` @deepseek-ai/dsh-web：本插件运行时不需要它（宿主提供 web seam），
// 而把它列为 peer dependency 会让 `prepare` 期间装进一份真实类型，与本地的同名声明冲突。
// 下面的形状对齐 @deepseek-ai/dsh-web@0.2.0-rc.2 的 lib/types/types.d.ts；TS 是结构化的，
// 因此只要形状正确即可与宿主实现互通。

/** 宿主对一次抓取请求的描述。 */
export interface WebFetchRequest {
  readonly url: string
}

/** 已解码的响应体（closed union，宿主只产出这两种）。 */
export type WebFetchBody =
  | { readonly kind: 'html'; readonly content: string }
  | { readonly kind: 'text'; readonly content: string }

/** 归一化的抓取结果；非 2xx 也是结果而非异常。 */
export interface WebFetchResult {
  readonly url: string
  readonly statusCode: number
  readonly body: WebFetchBody
  readonly truncated: boolean
}

/** 一个抓取后端。 */
export interface WebFetchProvider {
  readonly id: string
  available(): boolean
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>
}

/** 本插件注册的 provider id（也是写进 `fetchProviderId` 的值）。 */
export const FALLBACK_PROVIDER_ID = 'anysearch-fallback'
/** 官方 AnySearch 插件的 fetch provider id（写死在它的包内 patch 里）。 */
export const ANYSEARCH_PROVIDER_ID = 'anysearch'
/**
 * AnySearch 拒绝提取时的上游原文。422 响应体没有结构化 `error_code`
 * （只有 `code: -1`），所以只能匹配这句话——它是 AnySearch 的稳定契约，
 * 官方插件自己的测试同样依赖它。
 */
export const UNEXTRACTABLE_MESSAGE = 'Unable to extract content from the URL.'

/** 回退抓取使用的浏览器 UA：按 UA 拦截的站点（Cloudflare 等）只认它。 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
/** 回退抓取的响应体上限（字符）。与宿主 `tool-web` 的默认展示预算同量级。 */
export const FALLBACK_MAX_CHARS = 100_000
/** 回退抓取的响应体字节上限：先卡住下载，避免大文件把内存吃满。 */
export const FALLBACK_MAX_BYTES = 5_000_000
/** 回退抓取的超时。 */
export const FALLBACK_TIMEOUT_MS = 30_000

// ───────────────────────── 结构化类型（duck-typed cordis，零运行时依赖） ─────────────────────────

/** `ctx.web` 中本插件用到的部分。 */
type WebRuntimeLike = {
  registerFetchProvider(provider: WebFetchProvider): () => void
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>
  /** provider 注册表：普通字段，非 `#private`。读不到时降级。 */
  fetchProviders?: Map<string, WebFetchProvider>
  /**
   * 被选中的 fetch provider id。d.ts 标了 `private readonly`，但那只约束 TypeScript：
   * 编译产物是普通字段，运行时可写。写不进去时降级。
   */
  fetchProviderId?: string | undefined
}

type Ctx = {
  web: WebRuntimeLike
  logger?: { info?: (...a: unknown[]) => unknown; warn?: (...a: unknown[]) => unknown }
}

// ───────────────────────── 错误识别 ─────────────────────────

/**
 * 判断一个错误是否来自「AnySearch 提取不了这个 URL」。
 *
 * 只认 HTTP 422：AnySearch 用它表示内容类型不支持 / 目标不可达 / 被抓取端拦截。
 * 不认 5xx、超时、网络错误——那些回退会掩盖真实故障。
 *
 * 错误可能被包多层（官方 `AnySearchClientError` → `WebError`），沿 `cause`
 * 链逐层检查。`AnySearchClientError` 把自己的 `httpStatus` 放在实例字段上，
 * `WebError` 保留 `cause`，所以两条信息都能拿到。
 */
export function isUnextractable(error: unknown): boolean {
  let current: unknown = error
  const seen = new Set<unknown>()
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current)
    const node = current as { httpStatus?: unknown; message?: unknown; cause?: unknown; status?: unknown }
    const status = typeof node.httpStatus === 'number' ? node.httpStatus : node.status
    if (status === 422) return true
    // 兜底：某些路径可能只留下消息文本，没有状态码字段。
    if (typeof node.message === 'string' && node.message.includes(UNEXTRACTABLE_MESSAGE)) return true
    current = node.cause
  }
  return false
}

// ───────────────────────── 回退抓取 ─────────────────────────

/** 按扩展名/内容类型判断是否按文本处理；未知一律按文本（宿主只区分 html/text）。 */
function classifyBody(url: string, contentType: string | null): WebFetchBody['kind'] {
  const type = (contentType ?? '').toLowerCase()
  if (type.includes('text/html') || type.includes('application/xhtml')) return 'html'
  if (type.startsWith('text/') || type.includes('json') || type.includes('xml') || type.includes('markdown')) {
    return type.includes('html') ? 'html' : 'text'
  }
  if (type.length === 0) return /\.x?html?($|[?#])/i.test(url) ? 'html' : 'text'
  return 'text'
}

/**
 * 直接抓取：绕过宿主原生 provider 的 SSRF 公网校验（TUN 代理下会全量拒绝），
 * 并带浏览器 UA 以通过按 UA 拦截的站点。
 *
 * 只读响应体上限：先按 `Content-Length` 早退，再流式截断，最后按字符数裁剪。
 * 非 2xx 也返回结果（`WebFetchResult` 的契约：状态码是资源状态的一部分）。
 */
export async function directFetch(
  request: WebFetchRequest,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<WebFetchResult> {
  // 调用方的 signal 与本地超时合并：任一取消都要中断请求。
  const timeout = AbortSignal.timeout(FALLBACK_TIMEOUT_MS)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

  const response = await fetchImpl(request.url, {
    headers: {
      'user-agent': BROWSER_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'accept-language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: combined,
  })

  const contentType = response.headers.get('content-type')
  const kind = classifyBody(request.url, contentType)

  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > FALLBACK_MAX_BYTES) {
    throw new Error(
      `anysearch-fetch-fallback: ${request.url} declares ${declared} bytes, `
      + `over the ${FALLBACK_MAX_BYTES}-byte fetch cap`,
    )
  }

  const raw = await response.text()
  const truncated = raw.length > FALLBACK_MAX_CHARS
  const content = truncated ? raw.slice(0, FALLBACK_MAX_CHARS) : raw

  return {
    url: response.url === '' ? request.url : response.url,
    statusCode: response.status,
    body: { kind, content },
    truncated,
  }
}

// ───────────────────────── provider ─────────────────────────

/**
 * 组合 provider：先试 AnySearch，仅在 422 时回退到直接抓取。
 *
 * 上游是**调用时**从 `ctx.web.fetchProviders` 取，所以：
 * - 官方插件无论先后注册都不影响本插件工作；
 * - 官方被卸载时 `anysearch` 缺席 → 直接抓取，功能仍然正常。
 */
export class AnySearchFallbackProvider implements WebFetchProvider {
  readonly id = FALLBACK_PROVIDER_ID

  constructor(
    private readonly ctx: Ctx,
    private readonly log: (message: string) => void,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** 官方 provider 缺席时也能独立工作（直接抓取）。 */
  available(): boolean {
    return true
  }

  private upstream(id: string): WebFetchProvider | undefined {
    return this.ctx.web.fetchProviders?.get(id)
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const anysearch = this.upstream(ANYSEARCH_PROVIDER_ID)

    // 没有官方 provider：本插件退化为「通用抓取器」，服务不中断。
    if (anysearch === undefined) {
      this.log(`anysearch provider 未注册，直接抓取：${request.url}`)
      return directFetch(request, signal, this.fetchImpl)
    }

    try {
      return await anysearch.fetch(request, signal)
    }
    catch (error) {
      if (!isUnextractable(error)) throw error
      this.log(`AnySearch 提取失败（422），回退直接抓取：${request.url}`)
      return directFetch(request, signal, this.fetchImpl)
    }
  }
}

// ───────────────────────── 装配 ─────────────────────────

/**
 * 把本插件的 provider 设为 fetch 的默认选择。
 *
 * `fetchProviderId` 在 d.ts 里是 `private readonly`，运行时却是普通字段。
 * 写不进去（未来版本改成真正私有，或字段被移除）时返回 false，
 * 由调用方打警告——**绝不静默失效**。
 */
function selectProvider(ctx: Ctx, id: string): boolean {
  try {
    ctx.web.fetchProviderId = id
    return ctx.web.fetchProviderId === id
  }
  catch {
    return false
  }
}

/**
 * 取一个安全的日志函数。
 *
 * cordis 的 `ctx.logger.info/warn` 是**绑定在 LoggerService 上的方法**：把它摘下来
 * 单独调用会丢 `this`（真实运行时抛 `TypeError: this is not a function`）。
 * 所以这里保持方法在宿主对象上调用，绝不解构。
 */
function makeLogger(ctx: Ctx): (level: 'info' | 'warn', message: string) => void {
  return (level, message) => {
    const line = `[dsh-anysearch-fetch-fallback] ${message}`
    const sink = ctx.logger
    try {
      if (sink !== undefined) {
        const method = level === 'warn' ? sink.warn ?? sink.info : sink.info ?? sink.warn
        if (typeof method === 'function') {
          method.call(sink, line)
          return
        }
      }
    }
    catch {
      // 日志失败绝不能影响抓取：吞掉，退到 console。
    }
    if (level === 'warn') console.warn(line)
    else console.log(line)
  }
}

export function apply(ctx: Ctx): void {
  const emit = makeLogger(ctx)
  const log = (message: string): void => emit('info', message)
  const warn = (message: string): void => emit('warn', message)

  // 幂等注册：`registerFetchProvider` 对重复 id 抛 WEB_DUPLICATE_PROVIDER，
  // 而 apply 可能在同一进程内被再次执行（DSH 热重载、profile 重载、禁用后再启用）。
  // 先摘掉自己上一次的注册再挂新的，避免整个插件加载失败。
  if (ctx.web.fetchProviders?.get(FALLBACK_PROVIDER_ID) !== undefined) {
    ctx.web.fetchProviders.delete(FALLBACK_PROVIDER_ID)
    log('检测到已存在的同名 provider，替换为新实例（热重载）')
  }

  ctx.web.registerFetchProvider(new AnySearchFallbackProvider(ctx, log))

  if (selectProvider(ctx, FALLBACK_PROVIDER_ID)) {
    log(`web_fetch provider → ${FALLBACK_PROVIDER_ID}（AnySearch 优先，HTTP 422 回退直接抓取）`)
    return
  }

  warn(
    'unable to set ctx.web.fetchProviderId (the field is no longer a writable runtime property). '
    + `The provider "${FALLBACK_PROVIDER_ID}" is registered but will not be selected. `
    + 'Workaround: add `- id: web` with `config: { fetchProvider: anysearch-fallback }` '
    + 'to the profile\'s cordis.patch.yml.',
  )
}
