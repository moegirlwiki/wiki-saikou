# mediawiki-api-axios

mw-like MediaWiki Api wrapper for axios

## Example

```ts
import { MediaWikiApi } from 'mediawiki-api-axios'

const api = new MediaWikiApi('http://zh-dev.moegirl.org.cn/api.php')
api
  .get({
    action: 'query',
    meta: 'siteinfo',
  })
  .then(({ data }) => console.info(data))
```
