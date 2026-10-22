import test from 'node:test';
import assert from 'node:assert/strict';
import { collectExportPaths, normalizeZipPath, safeFileName } from '../lib/zip.js';

/** 只实现导出要用到的那几个方法 */
function fakeFs() {
    const files = [
        '/README.md',
        '/world_book/甲/entries/0_a.md',
        '/world_book/甲/entries/0_a.yaml',
        '/world_book/甲/_metadata.yaml',
        '/world_book/乙/entries/1_b.md',
        '/demo/x.txt',
    ];
    return {
        files: () => [...files],
        read: path => `content:${path}`,
        isDir: path => !path.split('/').pop().includes('.'),
    };
}

test('collectExportPaths：单文件 / 目录 / 整个工作区', () => {
    const fs = fakeFs();

    assert.deepEqual(collectExportPaths(fs, '/README.md'), ['/README.md']);
    assert.deepEqual(collectExportPaths(fs, '/world_book/甲'), [
        '/world_book/甲/entries/0_a.md',
        '/world_book/甲/entries/0_a.yaml',
        '/world_book/甲/_metadata.yaml',
    ]);
    assert.equal(collectExportPaths(fs, '').length, 6);
});

test('collectExportPaths：不存在的路径返回空数组', () => {
    const fs = fakeFs();
    fs.files = () => [];
    assert.deepEqual(collectExportPaths(fs, '/world_book/甲'), []);
});

test('normalizeZipPath：相对路径 → 绝对路径', () => {
    assert.equal(normalizeZipPath('world_book/甲/entries/0_a.md'), '/world_book/甲/entries/0_a.md');
    assert.equal(normalizeZipPath('/world_book/甲/entries/0_a.md'), '/world_book/甲/entries/0_a.md');
    assert.equal(normalizeZipPath('world_book\\甲\\entries\\0_a.md'), '/world_book/甲/entries/0_a.md');
    assert.equal(normalizeZipPath('./a/./b.txt'), '/a/b.txt');
});

test('normalizeZipPath：拒绝穿越和空路径', () => {
    assert.equal(normalizeZipPath('../../etc/passwd'), null);
    assert.equal(normalizeZipPath('a/../../b.txt'), null);
    assert.equal(normalizeZipPath(''), null);
    assert.equal(normalizeZipPath('   '), null);
    assert.equal(normalizeZipPath('///'), null);
});

test('safeFileName：去掉非法字符', () => {
    assert.equal(safeFileName('世界书/甲:测试'), '世界书_甲_测试');
    assert.equal(safeFileName('  '), 'workspace');
    assert.equal(safeFileName('a<b>c|d'), 'a_b_c_d');
});
