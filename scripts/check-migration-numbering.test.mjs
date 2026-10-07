import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertMigrationNumbering,
  inspectMigrationNumbering,
} from './check-migration-numbering.mjs';

const migrationFiles = (numbers) => numbers.map((number) => `${String(number).padStart(4, '0')}_migration.sql`);

describe('migration numbering checker', () => {
  it('accepts the canonical sequence with the documented 0008 gap', () => {
    const report = assertMigrationNumbering(migrationFiles(
      Array.from({ length: 23 }, (_, number) => number).filter((number) => number !== 8),
    ));

    assert.deepEqual(report.missingNumbers, []);
    assert.deepEqual(report.duplicateNumbers, []);
  });

  it('rejects duplicate migration numbers', () => {
    assert.throws(
      () => assertMigrationNumbering(['0000_schema.sql', '0001_first.sql', '0001_second.sql']),
      /duplicate migration number\(s\): 0001/,
    );
  });

  it('rejects every gap except the documented 0008 gap', () => {
    const report = inspectMigrationNumbering(migrationFiles([0, 1, 2, 3, 4, 5, 6, 7, 9, 11]));

    assert.equal(report.ok, false);
    assert.deepEqual(report.missingNumbers, [10]);
    assert.throws(
      () => assertMigrationNumbering(migrationFiles([0, 1, 2, 3, 4, 5, 6, 7, 9, 11])),
      /missing migration number\(s\): 0010/,
    );
  });

  it('rejects SQL files without a numbered migration prefix', () => {
    assert.throws(
      () => assertMigrationNumbering(['0000_schema.sql', 'README.sql']),
      /malformed migration filename\(s\): README\.sql/,
    );
  });
});
