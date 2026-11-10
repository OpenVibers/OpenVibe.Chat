'use strict';
const assert = require('node:assert/strict');
const { suite } = require('./helpers');
const t = suite('room attachments');
const files = require('../server/rooms/files');

t('room message attachments accept the public field name and enforce the ten-file limit', () => {
    assert.deepEqual(files.attachmentsFromBody({ attachments: [{ id: 'a' }] }), [{ id: 'a' }]);
    assert.deepEqual(files.attachmentsFromBody({ files: [{ id: 'b' }] }), [{ id: 'b' }]);
    assert.deepEqual(files.attachmentsFromBody({ attachments: 'invalid', files: [{ id: 'b' }] }), [{ id: 'b' }]);
    assert.throws(() => files.cleanFiles(Array(11).fill({ id: 'med_01ARZ3NDEKTSV4RRFFQ69G5FAV' })), (err) => err.code === 'rooms.files_too_many' && err.status === 413);
});

t.run();
