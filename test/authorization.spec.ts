import { describe, it } from 'mocha'
import { expect } from 'chai'
import { env } from 'process'
import { MediaWikiApi } from '../src/index'
import FormData from 'form-data'
;(globalThis as any).FormData = FormData

const api = new MediaWikiApi('https://zh.moegirl.org.cn/api.php', {
  headers: {
    'api-user-agent': env.MOEGIRL_API_USER_AGENT || '',
  },
})

function safePrintJSON(object: any) {
  if (object && typeof object === 'object') {
    object = copyWithoutCircularReferences([object], object)
  }
  return JSON.stringify(object)

  function copyWithoutCircularReferences(references: any, object: any) {
    var cleanObject: any = {}
    Object.keys(object).forEach(function (key) {
      var value = object[key]
      if (value && typeof value === 'object') {
        if (references.indexOf(value) < 0) {
          references.push(value)
          cleanObject[key] = copyWithoutCircularReferences(references, value)
          references.pop()
        } else {
          cleanObject[key] = '[Circular]'
        }
      } else if (typeof value !== 'function') {
        cleanObject[key] = value
      }
    })
    return cleanObject
  }
}

describe('Authorization', () => {
  it('Get token', async () => {
    const token = await api.token('login')
    expect(token).to.be.a('string')
  })

  // it('Login', async () => {
  //   const response = await api
  //     .postWithToken(
  //       'login',
  //       {
  //         action: 'clientlogin',
  //         loginreturnurl: 'https://zh.moegirl.org.cn/',
  //         username: '',
  //         password: '',
  //       },
  //       { assert: 'logintoken' }
  //     )
  //     .catch((e) => {
  //       console.error('LOGIN FAIL', e.data)
  //       return Promise.reject(e)
  //     })
  //   console.info('LOGIN OK', response.data)
  // })
})
