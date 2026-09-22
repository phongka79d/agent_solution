/**
 * Statement building shared by the P0 repositories.
 *
 * Table names are always literals written in this package, never caller input, so
 * they are interpolated; every value is bound as a parameter.
 */

/**
 * Value a P0 repository can bind into a parameterized statement. Money and other
 * NUMERIC columns travel as strings so no float rounding reaches the database.
 */
export type SqlValue =
  | string
  | number
  | boolean
  | Date
  | Record<string, unknown>
  | null
  | undefined;

/**
 * Column/value pair. An `undefined` value drops the column so the DDL default
 * applies, which is what `exactOptionalPropertyTypes` callers expect.
 */
export type SqlField = readonly [column: string, value: SqlValue];

/**
 * Builds a parameterized `INSERT ... RETURNING *` for a schema-qualified table.
 *
 * @param table - Schema-qualified table name, for example `agentos.customers`.
 * @param fields - Columns to insert; `undefined` values are dropped.
 * @returns The statement text and its positional parameter values.
 */
export function buildInsertQuery(
  table: string,
  fields: ReadonlyArray<SqlField>,
): { text: string; values: SqlValue[] } {
  const columns: string[] = [];
  const values: SqlValue[] = [];

  for (const [column, value] of fields) {
    if (value === undefined) {
      continue;
    }

    columns.push(column);
    values.push(value);
  }

  const placeholders = columns.map((_column, index) => `$${index + 1}`).join(', ');

  return {
    text: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    values,
  };
}

/**
 * Returns the single row an `INSERT ... RETURNING` or `UPDATE ... RETURNING`
 * statement produced.
 *
 * @param rows - Rows returned by the statement.
 * @param table - Schema-qualified table name, for the failure message.
 * @returns The first row.
 * @throws Error `PERSISTENCE_ROW_MISSING` when the statement returned no row.
 */
export function requireRow<Row>(rows: ReadonlyArray<Row>, table: string): Row {
  const row = rows[0];

  if (row === undefined) {
    throw new Error(`PERSISTENCE_ROW_MISSING: ${table} returned no row for a RETURNING statement.`);
  }

  return row;
}
