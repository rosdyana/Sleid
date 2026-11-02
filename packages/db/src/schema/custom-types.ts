import { customType } from 'drizzle-orm/pg-core'

/** Binary column. postgres-js returns Buffer, which is a Uint8Array, so no conversion is needed. */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
})
