import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGate } from '../server/limits.js';

test('makeGate: без binding считает в памяти', async () => {
  const g = makeGate(undefined, 2, 60000);
  assert.equal(await g('a'), true);
  assert.equal(await g('a'), true);
  assert.equal(await g('a'), false);
  assert.equal(await g('b'), true);
});

test('makeGate: слушается лимитер Cloudflare и передаёт ключ строкой', async () => {
  const seen = [];
  const g = makeGate({ limit: async o => { seen.push(o); return { success: seen.length < 2 }; } }, 1000, 60000);
  assert.equal(await g(7), true);
  assert.equal(await g(7), false);
  assert.deepEqual(seen, [{ key: '7' }, { key: '7' }]);
});

test('makeGate: если лимитер Cloudflare упал, не блокируем людей, считаем в памяти', async () => {
  const g = makeGate({ limit: async () => { throw new Error('boom'); } }, 1, 60000);
  assert.equal(await g('x'), true);
  assert.equal(await g('x'), false);
});
