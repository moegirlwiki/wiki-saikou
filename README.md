# mediawiki-api-axios

This library provides support for making requests to external api.php when not in the mw environment using methods very similar to the vanilla `mw.Api`

## Features

- Similar API to the vanilla `mw.Api`
- Parameter Schema automatic compliance: `{ "foo": ["bar", "baz"] }` → `{ "foo": "bar|baz" }`
- Token caching and retry mechanism
- TypeScript support
- With unit tests

## Example

```ts
import { MediaWikiApi } from 'mediawiki-api-axios'

const api = new MediaWikiApi('http://zh.moegirl.org.cn/api.php')
api
  .get({
    action: 'query',
    meta: 'siteinfo',
  })
  .then(console.info)
```
