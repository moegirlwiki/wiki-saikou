import { describe, expect, it } from 'vitest'
import { MwParamNormalizer } from './MwParamNormalizer.js'

describe('MwParamNormalizer', () => {
  it('normalize param values', () => {
    expect(MwParamNormalizer.normalizeParamValue(true)).to.eq('1')
    expect(MwParamNormalizer.normalizeParamValue(false)).to.be.undefined
    expect(MwParamNormalizer.normalizeParamValue(123)).to.eq('123')
    expect(MwParamNormalizer.normalizeParamValue(['foo', 'bar'])).to.eq(
      'foo|bar'
    )
    if (globalThis.File) {
      const fakeFile = new File(['foo'], 'foo.txt', { type: 'text/plain' })
      expect(MwParamNormalizer.normalizeParamValue(fakeFile)).to.instanceOf(
        File
      )
    }
  })

  it('normalize body (plain object)', () => {
    const data = {
      string: 'foo',
      number: 123,
      boolean: true,
      falsy: false,
      undefined: undefined,
      null: null,
      array: ['foo', 'bar'],
    }
    const normalized = MwParamNormalizer.normalizeBody(data)!
    expect(normalized).to.be.an('FormData')
    expect(normalized.get('string')).to.eq('foo')
    expect(normalized.get('number')).to.eq('123')
    expect(normalized.get('boolean')).to.eq('1')
    expect(normalized.get('falsy')).toBeNull()
    expect(normalized.get('undefined')).toBeNull()
    expect(normalized.get('null')).toBeNull()
    expect(normalized.get('array')).to.eq('foo|bar')
  })
})
