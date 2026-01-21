<div align="center">

# Wiki Saikou

SUPER COOL api package for MediaWiki

**- 同时兼容浏览器&Node.js 环境 -**<br>
**- Support both browser and Node.js environment -**

本库提供了与原版 `new mw.Api()` 非常相似的 api 请求封装。让你在非 MediaWiki 环境中轻松实现各种 wiki 操作。使用 TypeScript 编写~<br>
The library provides the out of box accessing to MediaWiki API in both browsers & Node.js, and the syntax is very similar to vanilla `new mw.Api()`. TypeScript definition included~

</div>

## 特色功能 Features

- Similar API to the vanilla `new mw.Api()`
- Parameter Schema automatic compliance: `{ "foo": ["bar", "baz"], watch: false }` → `{ "foo": "bar|baz" }`
- Token caching and retry mechanism
- TypeScript support
- With unit tests
- User authentication supports out of the box \*(also applicable to Node.js!)

## 开箱即用 Out of box

**通过 NPM 包安装 Installa via NPM**

```sh
# Via pnpm:
pnpm add wiki-saikou
# Yarn? sure:
yarn add wiki-saikou
# Or just npm:
npm install wiki-saikou
```

Then, import it to your project:

```ts
import { MediaWikiApi } from 'wiki-saikou'
const api = new MediaWikiApi('https://zh.moegirl.org.cn/api.php')
// ...
```

---

**在浏览器中直接使用 Use directly in the browser**

```html
<!-- Method 1: Using ES Module (recommended) -->
<script type="module">
  import { MediaWikiApi } from 'https://esm.run/wiki-saikou'
  const api = new MediaWikiApi('https://zh.moegirl.org.cn/api.php')
  // ...
</script>

<!-- Method 2: Using UMD bundle -->
<script src="https://cdn.jsdelivr.net/npm/wiki-saikou/lib/index.umd.js"></script>
<script>
  const { MediaWikiApi } = window.WikiSaikou
  const api = new MediaWikiApi('https://zh.moegirl.org.cn/api.php')
  // ...
</script>

<!-- Method 3: Using import maps (experimental) -->
<script type="importmap">
  {
    "imports": {
      "wiki-saikou": "https://esm.run/wiki-saikou"
    }
  }
</script>
<script type="module">
  import { MediaWikiApi } from 'wiki-saikou'
  const api = new MediaWikiApi('https://zh.moegirl.org.cn/api.php')
  // ...
</script>
```

**Deno via CDN**

```ts
import { MediaWikiApi } from 'https://esm.run/wiki-saikou/node'
const api = new MediaWikiApi('https://zh.moegirl.org.cn/api.php')
// ...
```

## 使用方法 Usage

> You can find sample code snippets in [unit test folder](test/).

It's similar to the `new mw.Api()`.

### 入口文件 Entry file

```ts
// automatically imports the correct entry file based on the environment
import { MediaWikiApi } from 'wiki-saikou'
// specify the entry file manually
import { MediaWikiApi } from 'wiki-saikou/node'
import { MediaWikiApi } from 'wiki-saikou/browser'
```

### Constructor

**`new MediaWikiApi(config: WikiSaikouInitConfig)`**

```ts
interface WikiSaikouConfig {
  /**
   * @default undefined // required in Node.js environment
   * @default `${wgServer}${wgScriptPath}/api.php` // in MW pages
   * @description The MediaWiki API endpoint, e.g. "https://www.mediawiki.org/w/api.php"
   * @optional In real MediaWiki browser pages, `baseURL` can be omitted and will be inferred automatically based on `window.mw`
   */
  baseURL: string
  /**
   * Transport/runtime options passed to the underlying Fexios instance (headers, fetch, credentials, etc.).
   * @default { responseType: 'json' }
   */
  fexiosConfigs: Partial<FexiosConfigs>
  /**
   * Default query parameters merged into every request.
   * @default { action: 'query' }
   */
  defaultParams: MwApiParams
  /**
   * When true, responses whose JSON body contains `error`/`errors` will throw `MediaWikiApiError` even if HTTP status is 2xx.
   * @default false
   */
  throwOnApiError: boolean
}
```

**Deprecated** (for backward compatibility):

`new MediaWikiApi(baseURL: string, options?: Partial<FexiosConfigs>, defaultParams?: MwApiParams)`

### Core requests

- `get<T = any>(query: MwApiParams, options?: Partial<FexiosRequestOptions>): Promise<FexiosFinalContext<MwApiResponse<T>>>`

  - Performs a GET request. `query` will be merged with `config.defaultParams`.

- `post<T = any>(body: MwApiParams | URLSearchParams | FormData, options?: Partial<FexiosRequestOptions>): Promise<FexiosFinalContext<MwApiResponse<T>>>`
  - Performs a POST request. Body and query are normalized to API-friendly formats.
- `postWithToken<T = any>(tokenType: MwTokenName, body: MwApiParams, options?: { tokenName?: string; retry?: number; noCache?: boolean }): Promise<FexiosFinalContext<MwApiResponse<T>>>`
  - Performs a POST request with a token.
  - `tokenType`: The type of token to use.
  - `body`: The body of the request.
  - `options`: The options for the request.
    - `tokenName`: The name of the token to use.
    - `retry`: The number of times to retry the request.
    - `noCache`: Whether to cache the token.
  - This method will manage the token cache and retry logic automatically.

### Authentication

**Node.js** only:

- `login(lgname: string, lgpassword: string, params?: MwApiParams, postOptions?: { retry?: number; noCache?: boolean; autoRelogin?: boolean; autoReloginRetries?: number }): Promise<{ result: 'Success' | 'NeedToken' | 'WrongToken' | 'Failed'; token?: string; reason?: { code: string; text: string }; lguserid: number; lgusername: string }>`
  - Login with bot password. Throws `WikiSaikouError(LOGIN_FAILED)` if result is not `Success`.
  - `autoRelogin` defaults to `true` and will attach `assertuser` to future requests. If the session drops, the SDK auto re-logins and retries the request.
  - `autoReloginRetries` defaults to `3` and controls how many re-login attempts are made per `assertnameduserfailed` incident.

**Browser** only:

- `clientLogin(username: string, password: string, params?: ClientLoginOptions): Promise<{ status: "PASS"; username: string; }>;`
  - Login with regular username & password. Throws `WikiSaikouError(LOGIN_FAILED)` if status is not `PASS`.

## 实用工具 Useful helpers

### FexiosSaikou

A pre-configured Fexios instance with MediaWiki-friendly defaults:

- MediaWiki-specific request/response params normalization
- built-in token management
- error handling

### MwParamNormalizer

`MwParamNormalizer` is a utility class that helps normalize MediaWiki API parameters.

```ts
import { MwParamNormalizer } from 'wiki-saikou'

MwParamNormalizer.normalizeBody({
  string: 'foo',
  number: 123,
  boolean: true,
  falsy: false,
  undefined: undefined,
  null: null,
  array: ['foo', 'bar'],
  file: new Blob(['file contents'], { type: 'text/plain' }),
})
// Result:
/**
 * FormData
 * string=foo
 * number=123
 * boolean=1
 * array=foo|bar
 * file=[Blob]
 */
```

## 错误处理 Errors and types

> [!important]
>
> WikiSaikou will NOT throw errors for these situations by default:
>
> 1. non-2xx HTTP status codes
> 2. MediaWiki API responses containing `error` or `errors` field
>
> You should handle these situations manually by checking the response context.

- `WikiSaikouError`
  - Transport/network failures (e.g., fetch failure, HTTP layer issues)
  - SDK behavioral errors such as exhausted internal retries or misconfigurations
  - Note: When MediaWiki API responds with JSON containing error/errors, a MediaWikiApiError should be thrown instead
- `WikiSaikouErrorCode`
  - Enum of error codes used in `WikiSaikouError`

> [!NOTE]
>
> If you set `options.throwOnApiError = true` when constructing `MediaWikiApi`,
> then WikiSaikou will handle MediaWiki API errors automatically by throwing `MediaWikiApiError` for you.

- `MediaWikiApiError`
  - fetch succeeded but JSON includes `error` or `errors.length > 0`
  - Special states (e.g., login NeedToken/WrongToken) are also considered API-side errors
  - Note: network/retry issues belong to WikiSaikouError, not this class

---

## 浏览器专属 Browser only

Besides `MediaWikiApi`, the browser bundle also provides `MediaWikiForeignApi` which presets CORS-friendly defaults for cross-origin API access.

- `new MediaWikiForeignApi(config: WikiSaikouInitConfig)`
  - Defaults `credentials: 'include'`, `mode: 'cors'`, and injects `origin` automatically based on `location.origin`.

Example:

```ts
import { MediaWikiForeignApi } from 'wiki-saikou/browser'
const api = new MediaWikiForeignApi({
  baseURL: 'https://commons.wikimedia.org/w/api.php',
})
```

---

> MIT License
>
> Copyright (c) 2022 萌娘百科 User:机智的小鱼君 (A.K.A. Dragon-Fish)
