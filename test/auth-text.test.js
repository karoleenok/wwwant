import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyInitData, signInitData } from '../server/auth.js';
import { parseAdd, parseAmount, etaWeeks, plural, fmt } from '../server/text.js';
import { normLink, cleanItem } from '../server/validate.js';

const T = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

test('initData: верная подпись проходит', () => {
  const u = verifyInitData(signInitData({ id: 5, first_name: 'Каролина' }, T), T);
  assert.deepEqual(u, { id: 5, first_name: 'Каролина' });
});
test('initData: чужой токен, подмена поля, просрочка, будущее', () => {
  const ok = signInitData({ id: 5, first_name: 'A' }, T);
  assert.equal(verifyInitData(ok, '999999:' + 'x'.repeat(35)), null);
  assert.equal(verifyInitData(ok.replace('%22id%22%3A5', '%22id%22%3A6'), T), null);
  const old = signInitData({ id: 5, first_name: 'A' }, T, Math.floor(Date.now() / 1000) - 90000);
  assert.equal(verifyInitData(old, T, 86400), null);
  const fut = signInitData({ id: 5, first_name: 'A' }, T, Math.floor(Date.now() / 1000) + 4000);
  assert.equal(verifyInitData(fut, T), null);
  assert.equal(verifyInitData('', T), null);
  assert.equal(verifyInitData('hash=abc', T), null);
});

test('parseAdd: ссылка, цена в конце, название', () => {
  assert.deepEqual(parseAdd('Лампа 4300 https://www.ozon.ru/t/abc123'), { link: 'https://www.ozon.ru/t/abc123', price: 4300, name: 'Лампа' });
  assert.deepEqual(parseAdd('Шкаф-купе 11.500 р'), { link: '', price: 11500, name: 'Шкаф-купе' });
  assert.deepEqual(parseAdd('Кофемашина 34 900 ₽'), { link: '', price: 34900, name: 'Кофемашина' });
  assert.equal(parseAdd('iPhone 15').price, 0);
  assert.equal(parseAdd('iPhone 15').name, 'iPhone 15');
  assert.equal(parseAdd('iPhone 15 79990').price, 79990);
  const only = parseAdd('https://market.yandex.ru/cc/9rsgau');
  assert.equal(only.link, 'https://market.yandex.ru/cc/9rsgau'); assert.equal(only.name, ''); assert.equal(only.price, 0);
  assert.equal(parseAdd('Лампа https://x.ru/a, спасибо').link, 'https://x.ru/a');
});
test('parseAdd: длинное название режется по слову', () => {
  const r = parseAdd('Очень длинное название товара с маркетплейса которое никуда не помещается в карточку 1990 ₽');
  assert.ok(r.name.length <= 61); assert.equal(r.price, 1990); assert.ok(r.name.endsWith('…'));
});
test('parseAmount, etaWeeks, plural, fmt', () => {
  assert.equal(parseAmount('3000'), 3000); assert.equal(parseAmount('3 000 ₽'), 3000); assert.equal(parseAmount('лампа'), 0); assert.equal(parseAmount('0'), 0);
  assert.equal(etaWeeks(7300, 3000), 3); assert.equal(etaWeeks(0, 3000), 0); assert.equal(etaWeeks(100, 0), 0);
  assert.equal(plural(1, ['а', 'б', 'в']), 'а'); assert.equal(plural(3, ['а', 'б', 'в']), 'б'); assert.equal(plural(11, ['а', 'б', 'в']), 'в'); assert.equal(plural(22, ['а', 'б', 'в']), 'б');
  assert.equal(fmt(11500), '11 500 ₽');
});
test('normLink и cleanItem отсекают опасное', () => {
  assert.equal(normLink('javascript:alert(1)'), null);
  assert.equal(normLink('data:text/html,x'), null);
  assert.equal(normLink('ftp://x.ru'), null);
  assert.equal(normLink('https://user:pw@x.ru/'), null);
  assert.equal(normLink('ozon.ru/t/1'), 'https://ozon.ru/t/1');
  assert.equal(normLink(''), '');
  assert.ok(cleanItem({ id: 1, name: 'a', price: 0, saved: 0, zone: 0 }).err);
  assert.ok(cleanItem({ id: 1, name: 'a', price: 5, saved: 0, zone: 3 }).err);
  assert.equal(cleanItem({ id: 1, name: 'a', price: 5, saved: 9, zone: 0 }).v.saved, 5);
  assert.equal(cleanItem({ id: 1, name: '<b>x</b>‮', price: 5, saved: 0, zone: 0, bg: 'red', icon: '../x' }).v.bg, '');
  assert.equal(cleanItem({ id: 1, name: 'a', price: 5, saved: 0, zone: 0, icon: '../x' }).v.icon, 'package');
});
