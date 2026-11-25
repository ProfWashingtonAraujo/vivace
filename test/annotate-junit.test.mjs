import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { annotationLines, failuresFromJunit } from '../scripts/annotate-junit.mjs';

const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="Fase 0" tests="3" failures="2">
    <testcase name="passa" time="0.1" classname="test"/>
    <testcase name="check-in sobrevive" time="0.2" classname="test">
      <failure type="testCodeFailure" message="o check-in foi apagado &amp; sumiu">
        AssertionError: o check-in foi apagado
      </failure>
    </testcase>
    <testcase name="mensagem &quot;forjada&quot;" time="0.3" classname="test">
      <failure type="testCodeFailure" message="remetente forjado">detalhe</failure>
    </testcase>
  </testsuite>
</testsuites>`;

describe('failuresFromJunit', () => {
  it('lista so os testes que falharam, com a mensagem', () => {
    const failures = failuresFromJunit(xml);
    assert.equal(failures.length, 2);
    assert.equal(failures[0].name, 'check-in sobrevive');
    assert.equal(failures[0].message, 'o check-in foi apagado & sumiu');
  });

  it('desfaz as entidades XML no nome e na mensagem', () => {
    assert.equal(failuresFromJunit(xml)[1].name, 'mensagem "forjada"');
  });

  it('xml sem falhas devolve lista vazia', () => {
    assert.deepEqual(failuresFromJunit('<testsuites><testsuite><testcase name="a"/></testsuite></testsuites>'), []);
  });

  it('entrada vazia ou invalida nao quebra', () => {
    assert.deepEqual(failuresFromJunit(''), []);
    assert.deepEqual(failuresFromJunit(undefined), []);
  });

  it('um erro dentro de um hook (before) tambem conta', () => {
    const hook = '<testsuite name="s"><testcase name="before hook"><error message="import falhou"/></testcase></testsuite>';
    assert.equal(failuresFromJunit(hook)[0].message, 'import falhou');
  });
});

describe('annotationLines', () => {
  const failures = Array.from({ length: 14 }, (_, index) => ({ name: `teste ${index}`, message: `falha ${index}` }));

  it('emite no maximo 10 anotacoes de erro (o limite do GitHub por passo) mais um resumo', () => {
    const lines = annotationLines(failures, { limit: 10 });
    assert.equal(lines.filter(line => line.startsWith('::error')).length, 10);
    assert.match(lines.at(-1), /14 teste\(s\) falharam; 10 mostrados/);
  });

  it('escapa quebra de linha e porcentagem como o GitHub exige', () => {
    const [line] = annotationLines([{ name: 'a', message: 'linha1\nlinha2 100%' }], { limit: 10 });
    assert.ok(!line.includes('\n'));
    assert.ok(line.includes('%0A'));
    assert.ok(line.includes('100%25'));
  });

  it('corta mensagens muito longas', () => {
    const [line] = annotationLines([{ name: 'a', message: 'x'.repeat(5000) }], { limit: 10 });
    assert.ok(line.length < 1000);
  });

  it('sem falhas nao emite nada', () => {
    assert.deepEqual(annotationLines([], { limit: 10 }), []);
  });
});
