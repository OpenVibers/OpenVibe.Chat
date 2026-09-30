#!/usr/bin/env node
/**
 * Runs every test in test/ — the files named *.test.js — each in its own process, and fails
 * if any of them fails. They use in-process stubs of OpenVibe.Live and OpenVibe.Network only;
 * none of them needs the network or a running site.
 *
 *   npm test                 # everything
 *   npm test -- ws import    # only files whose name contains one of the words
 *   npm test -- --strict     # a skipped test fails the run too
 *
 *   npm run test:pg          # the same on PostgreSQL through PgBouncer, plus Valkey (OV_TEST_PG_URL,
 *                            # OV_TEST_PG_DIRECT_URL, OV_TEST_VALKEY_URL: openvibe-sdk scripts/test-services.sh up)
 *
 * Every test process gets one migrated database from test/helpers/pg-preload.mjs (node --import): an
 * in-memory PGlite, or with OV_TEST_STORE=pg a schema and roles of its own on the PostgreSQL server.
 *
 * A test that cannot run something here prints `<label>: skipped (<why>)`: that file is listed with
 * ○ and not counted as passed (openvibe-shared/test-runner).
 */
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
require('openvibe-shared/test-runner').main({
    dir: __dirname, timeoutMs: 60000, pad: 32, parallel: 1,
    nodeArgs: ['--import', pathToFileURL(path.join(__dirname, 'helpers', 'pg-preload.mjs')).href],
});
