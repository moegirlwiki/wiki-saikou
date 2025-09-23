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

**通用导入方法 Common import methods**

```ts
// Automatically detect the environment and import the appropriate version
import { MediaWikiApi } from 'wiki-saikou'
// Or specify the environment
import { MediaWikiApi } from 'wiki-saikou/browser' // for frontend projects
import { MediaWikiApi } from 'wiki-saikou/node' // for Node.js projects

const api = new MediaWikiApi('https://zh.moegirl.org.cn/api.php')
// ...
```

**在浏览器中直接使用 Use directly in the browser**

```html
<!-- ESM -->
<script type="module">
  import { MediaWikiApi } from 'https://esm.run/wiki-saikou/browser'
  const api = new MediaWikiApi('https://zh.moegirl.org.cn/api.php')
</script>

<!-- UMD -->
<script src="https://cdn.jsdelivr.net/npm/wiki-saikou/dist/browser.umd.js"></script>
<script>
  const { MediaWikiApi } = window.WikiSaikou
  const api = new MediaWikiApi('https://zh.moegirl.org.cn/api.php')
</script>
```

**在 Deno, Bun, etc. 中使用**

You should use the node version, which includes the cookie jar plugin.

```js
import { MediaWikiApi } from 'https://esm.run/wiki-saikou/node'
const api = new MediaWikiApi('https://zh.moegirl.org.cn/api.php')
```

## 使用方法 Usage

You can use WikiSaikou just like the `new mw.Api()`

You can find some sample code snippets [here](test/).

Below is the documentation of MediaWikiApi.

---

### `MediaWikiApi` {class MediaWikiApi}

**Main methods**:

#### `new MediaWikiApi(baseURL?: string, options?: Partial<FexiosConfigs>)`

- `baseURL`: API endpoint of your target wiki site (e.g. https://mediawiki.org/w/api.php)
  - **Not required but with conditions**: If you are using it in the browser environment, and the website runs MediaWiki. The instance will automatically use the API endpoint of current wiki.
- `options`: {LylaRequestOptions}

#### `login(username: string, password: string): Promise<{ result: 'Success' | 'Failed'; lguserid: number; lgusername: string }>`

Login your account.

In the browser environment, use `clientLogin` instead.

#### `get<T = any>(params: MwApiParams, options?: FexiosRequestOptions): Promise<FexiosFinalContext<T>>`

Make `GET` request

#### `post<T = any>(body: MwApiParams, options?: LylaRequestOptions): Promise<FexiosFinalContext<T>>`

Make `POST` request

#### `postWithToken<T = any>(tokenType: MwTokenName, body: MwApiParams, options?: LylaRequestOptions): Promise<FexiosFinalContext<T>>`

Make `POST` request with specified token.

```ts
type MwTokenName =
  | 'createaccount'
  | 'csrf'
  | 'login'
  | 'patrol'
  | 'rollback'
  | 'userrights'
  | 'watch'
```

### 工具函数 Auxiliary utilities

#### `get request` {Fexios}

Get `Fexios` instance of current MediaWikiApi instance

#### `MediaWikiApi.normalizeParamValue(params: MwApiParams[keyof MwApiParams]): string | File | undefined` (static)

Normalize input params to standard MediaWiki request params.

- `string[] → string`: `['foo', 'bar', 'baz'] → 'foo|bar|baz`
- `false → undefined`: remove false items

#### `MediaWikiApi.createRequestHandler(baseURL: string, options?: Partial<FexiosRequestOptions>): Fexios` (static)

Create your own Fexios instance.

**Warning: The instance created by this method does not include responsive getters/setters (described below) and the out of box cookie controls.**

#### `get/set defaultOptions` {AxiosRequestOptions} (responsive\* getter/setter)

defaults: `{}`

#### `get/set defaultParams` {MwApiParams} (responsive\* getter/setter)

defaults:

```ts
this.defaultParams = {
  action: 'query',
  errorformat: 'plaintext',
  format: 'json',
  formatversion: 2,
}
```

### \*About the responsive getter/setter

Modifying these properties on the instance will automatically recreate the Axios instance of current MediaWikiApi instance. You can modify them directly and safely.

---

> MIT License
>
> Copyright (c) 2022 萌娘百科 User:机智的小鱼君 (A.K.A. Dragon-Fish)
