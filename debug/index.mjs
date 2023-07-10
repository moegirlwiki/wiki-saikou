import { MediaWikiApi } from '../dist/index.js'
import { env } from 'node:process'

const api = new MediaWikiApi('https://zh.moegirl.org.cn/api.php', {
  headers: {
    'api-user-agent': env.MOEGIRL_API_USER_AGENT || '',
  },
})

const username = env.MOEGIRL_USERNAME || ''
const password = env.MOEGIRL_PASSWORD || ''

api.login(username, password).then(console.info)
