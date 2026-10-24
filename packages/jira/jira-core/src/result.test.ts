/**
 * Tests for core/result — the composition primitives (decision 104).
 * Zero dependencies: Node's built-in runner (decision 66).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { andThen, collect, err, isErr, isOk, map, mapErr, ok, orElse, partition, pipe, unwrapOr } from './result.ts'

describe('result atoms', () => {
  it('produces frozen values, so "modify" can only mean "produce a new one"', () => {
    const good = ok(1)
    const bad = err('boom')
    assert.equal(Object.isFrozen(good), true)
    assert.equal(Object.isFrozen(bad), true)
  })

  it('narrows with isOk / isErr', () => {
    const good = ok(1)
    const bad = err('boom')
    assert.equal(isOk(good), true)
    assert.equal(isErr(bad), true)
    if (isOk(good)) assert.equal(good.value, 1)
    if (isErr(bad)) assert.equal(bad.error, 'boom')
  })

  it('maps the success and passes the error through untouched', () => {
    assert.deepEqual(map(ok(2), n => n * 3), ok(6))
    const failure = err('boom')
    assert.equal(map(failure as never, (n: number) => n), failure)
  })

  it('maps the error and passes the success through untouched', () => {
    assert.deepEqual(mapErr(err('boom'), e => e.length), err(4))
    const success = ok(1)
    assert.equal(mapErr(success, (e: string) => e.length), success)
  })

  it('chains fallible steps with andThen', () => {
    const half = (n: number) => (n % 2 === 0 ? ok(n / 2) : err('odd'))
    assert.deepEqual(andThen(ok(8), half), ok(4))
    assert.deepEqual(andThen(ok(9), half), err('odd'))
    assert.deepEqual(andThen(err('earlier'), half), err('earlier'))
  })

  it('recovers with orElse', () => {
    assert.deepEqual(orElse(err('missing'), () => ok(0)), ok(0))
    assert.deepEqual(orElse(ok(1), () => ok(0)), ok(1))
  })

  it('reads a fallback without throwing', () => {
    assert.equal(unwrapOr(ok(7), 0), 7)
    assert.equal(unwrapOr(err('missing'), 0), 0)
  })

  it('collects strictly (first error wins) and partitions tolerantly', () => {
    assert.deepEqual(collect([ok(1), ok(2)]), ok([1, 2]))
    assert.deepEqual(collect([ok(1), err('a'), err('b')]), err('a'))

    const split = partition([ok(1), err('a'), ok(2)])
    assert.deepEqual(split.values, [1, 2])
    assert.deepEqual(split.errors, ['a'])
    assert.equal(Object.isFrozen(split), true)
  })

  it('composes left to right with pipe', () => {
    const double = (n: number) => n * 2
    const stringify = (n: number) => `#${n}`
    assert.equal(pipe(3, double), 6)
    assert.equal(pipe(3, double, stringify), '#6')
    assert.equal(pipe(3, double, stringify, s => s.length), 2)
  })
})
