<div align="center">

# MediaWiki Api

**~同时兼容浏览器&Node.js 环境~**<br>
**~Support both browser and Node.js environment~**

这个包实现了与原版 `new mw.Api()` 非常相似的 api 请求封装。让你在非 MediaWiki 环境中轻松实现各种 wiki 操作。<br>
This library provides support for making requests to external api.php when not in the mw environment using methods very similar to the vanilla `new mw.Api()`

</div>

## 特色功能 Features

- Similar API to the vanilla `new mw.Api()`
- Parameter Schema automatic compliance: `{ "foo": ["bar", "baz"], watch: false }` → `{ "foo": "bar|baz" }`
- Token caching and retry mechanism
- TypeScript support
- With unit tests
- User authentication supports out of the box \*(also applicable to Node.js!)

## 开箱即用/Out of box

**安装/installation**

```sh
# Via pnpm:
pnpm add mediawiki-api-axios
# Yarn? sure:
yarn add mediawiki-api-axios
# Or just npm:
npm install mediawiki-api-axios
```

Then, import it to your project:

```ts
import { MediaWikiApi } from 'mediawiki-api-axios'
const api = new MediaWikiApi('http://zh.moegirl.org.cn/api.php')
// ...
```

**在浏览器中直接使用/Use directly in the browser**

```ts
import(
  'https://unpkg.com/mediawiki-api-axios@latest/dist/index.js?module'
).then(({ MediaWikiApi }) => {
  const api = new MediaWikiApi('http://zh.moegirl.org.cn/api.php')
  // ...
})
```

Then use it just like the `new mw.Api()`

## 使用方法/Usage

You can find some sample code snippets [here](test/).

Below is the documentation of MediaWikiApi.

---

### `MediaWikiApi` {class MediaWikiApi}

**Main methods**:

#### Constructor `new MediaWikiApi(baseURL:string, options?: AxiosRequestConfig)`

- `baseURL`: API endpoint of your target wiki site (e.g. https://mediawiki.org/w/api.php)
- `options`: {AxiosRequestConfig}

#### `login(username: string, password: string): Promise<{ status: 'PASS' | 'FAIL'; username: string }>`

Login you account.

#### `get<T = any>(params: MwApiParams, options?: AxiosRequestConfig): Promise<AxiosResponse<T>>`

Make `GET` request

#### `post<T = any>(body: MwApiParams, options?: AxiosRequestConfig): Promise<AxiosResponse<T>>`

Make `POST` request

#### `postWithToken<T = any>(tokenType: MwTokenName, body: MwApiParams, options?: AxiosRequestConfig): Promise<AxiosResponse<T>>`

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

### Auxiliary utilities

#### `MediaWikiApi.ajax` {AxiosInstance} (getter)

Get `AxiosInstance` of current MediaWikiApi instance

#### `MediaWikiApi#adjustParamValue(params: MwApiParams): Record<string: string>` (static)

Adjust input params to standard MediaWiki request params.

- `string[] → string`: `['foo', 'bar', 'baz'] → 'foo|bar|baz`
- `false → undefined`: remove false items

#### `MediaWikiApi#createAxiosInstance(payload: { baseURL: string; params: MwApiParams; options: AxiosRequestConfig })` (static)

Create your own axios instance.

**Warning: The instance created by this method does not include responsive getters/setters (described below) and the out of box cookie controls.**

#### `MediaWikiApi.defaultOptions` {AxiosRequestOptions} (responsive\* getter/setter)

defaults: `{}`

#### `MediaWikiApi.defaultParams` {MwApiParams} (responsive\* getter/setter)

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
