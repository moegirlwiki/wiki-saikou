import { MwApi } from '../src'

const lyla = MwApi.createLylaInstance('https://zh.moegirl.org.cn/api.php')

lyla
  .post('', {
    json: {
      action: 'query',
      meta: 'userinfo',
      format: 'json',
      formatversion: 2,
    },
  })
  .then((i) => {
    console.info(
      typeof i.body === 'string'
        ? `${i.body.slice(0, 100)}${i.body.length > 100 ? '...' : ''}`
        : i.body
    )
  })
  .catch(console.error)
