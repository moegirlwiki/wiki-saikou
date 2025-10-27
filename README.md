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

**安装 Installation**

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

**在浏览器中直接使用 Use directly in the browser**

```js
import('https://unpkg.com/wiki-saikou/dist/browser.js').then(
  ({ MediaWikiApi }) => {
    const api = new MediaWikiApi('https://zh.moegirl.org.cn/api.php')
    // ...
  }
)
```

Then use it just like the `new mw.Api()`

## 使用方法 Usage

You can find sample code snippets in [unit test folder](test/).

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

- `login(lgname: string, lgpassword: string, params?: MwApiParams, postOptions?: { retry?: number; noCache?: boolean }): Promise<{ result: 'Success' | 'NeedToken' | 'WrongToken' | 'Failed'; token?: string; reason?: { code: string; text: string }; lguserid: number; lgusername: string }>`
  - Login with bot password. Throws `WikiSaikouError(LOGIN_FAILED)` if result is not `Success`.

**Browser** only:

- `clientLogin(username: string, password: string, params?: ClientLoginOptions): Promise<{ status: "PASS"; username: string; }>;`
  - Login with regular username & password. Throws `WikiSaikouError(LOGIN_FAILED)` if status is not `PASS`.

### Convenience

- `getUserInfo(): Promise<{ id: number; name: string; groups: string[]; rights: string[]; /* ...block fields */ }>`

### Static helpers (advanced)

- `MediaWikiApi.normalizeParamValue(value: MwApiParams[keyof MwApiParams]): string | Blob | undefined`
  - Arrays are joined with `|`, booleans map to `'1'`/omitted, numbers to strings.
- `MediaWikiApi.normalizeBody(body: any): FormData | undefined`
- `MediaWikiApi.createRequestHandler(baseURL: string): Fexios`

Note: the low-level handler created by `createRequestHandler` is for advanced scenarios and does not include any environment-specific enhancements beyond what the core sets up.

### Errors and types

- `WikiSaikouErrorCode` and `WikiSaikouError` represent transport/SDK-level failures (e.g., HTTP/network issues, exhausted retries).
- `MediaWikiApiError` represents MediaWiki API business errors (JSON includes `error`/`errors`, or special states like `NeedToken`/`WrongToken`).
- `MwApiParams`, `MwApiResponse<T>`, `MwTokenName` are exported for typing your calls.

---

### 浏览器相关 Browser

Besides `MediaWikiApi`, the browser bundle also provides `MediaWikiForeignApi` which presets CORS-friendly defaults for cross-origin API access.

- `new MediaWikiForeignApi(config: WikiSaikouInitConfig)`
  - Defaults `credentials: 'include'`, `mode: 'cors'`, and injects `origin` automatically based on `location.origin`.

Example:

```ts
import { MediaWikiForeignApi } from 'wiki-saikou/browser'
const api = new MediaWikiForeignApi({
  baseURL: 'https://example.org/w/api.php',
})
```

---

> MIT License
>
> Copyright (c) 2022 萌娘百科 User:机智的小鱼君 (A.K.A. Dragon-Fish)
