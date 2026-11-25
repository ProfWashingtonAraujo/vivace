import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseImageUpload } from '../lib/image-upload.mjs';

const dataUrl = (mime, bytes) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const jpeg = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4];
const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2];
const webp = [...Buffer.from('RIFF'), 9, 0, 0, 0, ...Buffer.from('WEBP'), 1, 2];
const limit = 1024;

describe('parseImageUpload', () => {
  it('aceita jpeg, png e webp reais', () => {
    assert.equal(parseImageUpload(dataUrl('image/jpeg', jpeg), limit).mime, 'image/jpeg');
    assert.equal(parseImageUpload(dataUrl('image/png', png), limit).mime, 'image/png');
    assert.equal(parseImageUpload(dataUrl('image/webp', webp), limit).mime, 'image/webp');
  });

  it('devolve o tamanho decodificado', () => {
    assert.equal(parseImageUpload(dataUrl('image/jpeg', jpeg), limit).size, jpeg.length);
  });

  it('recusa SVG, que carrega script, mesmo com o conteudo valido', () => {
    assert.equal(parseImageUpload(dataUrl('image/svg+xml', Buffer.from('<svg onload="x()"/>')), limit), null);
  });

  it('recusa texto declarado como jpeg (bytes magicos nao batem)', () => {
    assert.equal(parseImageUpload(dataUrl('image/jpeg', Buffer.from('<html>oi</html>')), limit), null);
  });

  it('recusa png declarado como jpeg', () => {
    assert.equal(parseImageUpload(dataUrl('image/jpeg', png), limit), null);
  });

  it('recusa gif, que nao esta na lista permitida', () => {
    assert.equal(parseImageUpload(dataUrl('image/gif', Buffer.from('GIF89a....')), limit), null);
  });

  it('recusa acima do tamanho maximo decodificado', () => {
    assert.equal(parseImageUpload(dataUrl('image/jpeg', [...jpeg, ...new Array(2000).fill(1)]), limit), null);
  });

  it('recusa sem ;base64, sem virgula, vazio e nao-string', () => {
    assert.equal(parseImageUpload('data:image/jpeg,abcd', limit), null);
    assert.equal(parseImageUpload('data:image/jpeg;base64', limit), null);
    assert.equal(parseImageUpload('data:image/jpeg;base64,', limit), null);
    assert.equal(parseImageUpload(undefined, limit), null);
    assert.equal(parseImageUpload(42, limit), null);
  });

  it('recusa base64 invalido', () => {
    assert.equal(parseImageUpload('data:image/jpeg;base64,@@@@!!!!', limit), null);
  });

  it('recusa URL http, que nao e upload', () => {
    assert.equal(parseImageUpload('https://images.unsplash.com/x.jpg', limit), null);
  });
});
