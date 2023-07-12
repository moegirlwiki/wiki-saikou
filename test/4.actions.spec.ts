import 'dotenv/config'
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { env } from 'process'
import { MediaWikiApi } from '../src/index'

const api = new MediaWikiApi('https://zh.moegirl.org.cn/api.php', {
  headers: {
    'api-user-agent': env.MOEGIRL_API_USER_AGENT || '',
  },
})

const username = env.MOEGIRL_USERNAME || ''
const password = env.MOEGIRL_PASSWORD || ''

const now = new Date()
const editTitle = `User:${username}/sandbox/wiki-saikou`
let editPageid = 0
let editNewrevid = 0

describe('Actions', () => {
  it('Login', async () => {
    const login = await api.login(username, password)
    expect(login.result).to.equal('Success')
  })

  it('Do edit', async () => {
    const {
      data: { edit },
    } = await api.postWithEditToken({
      action: 'edit',
      title: editTitle,
      text: now.toISOString(),
      summary: '[Automatic] Unit tests for https://npm.im/wiki-saikou',
    })
    expect(edit.result).to.equal('Success')
    editPageid = edit.pageid
    editNewrevid = edit.newrevid
  })

  it('Check edit contents', async () => {
    const {
      data: {
        query: {
          pages: [page],
        },
      },
    } = await api.get({
      action: 'query',
      revids: editNewrevid,
      prop: 'revisions',
      rvprop: 'user|content',
    })
    expect(page.pageid).to.equal(editPageid)
    expect(page.revisions[0].user).to.equal(username)
    expect(page.revisions[0].content).to.equal(now.toISOString())
  })
})
