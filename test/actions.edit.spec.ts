import 'dotenv/config'
import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'process'
import { MediaWikiApi } from 'wiki-saikou'
import {
  MOCK_API_ENDPOINT_URL,
  MOCK_MW_USERNAME,
  MOCK_MW_PASSWORD,
  mockFetch,
} from './__mock__/mwApiServer.js'

const api = new MediaWikiApi(MOCK_API_ENDPOINT_URL.href, {
  headers: {
    'api-user-agent': env.API_USER_AGENT || '',
  },
  fetch: mockFetch,
})

const username = MOCK_MW_USERNAME
const password = MOCK_MW_PASSWORD

const now = new Date()
const editTitle = `User:${username}/sandbox/wiki-saikou`
let editPageid = 0
let editNewrevid = 0

describe('Actions (edit)', { sequential: true }, () => {
  beforeAll(async () => {
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
