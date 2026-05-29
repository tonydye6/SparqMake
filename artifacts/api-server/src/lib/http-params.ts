/**
 * Express 5's `ParamsDictionary` and parsed query types model values as
 * `string | string[]`. Route params and most query params are single strings
 * at runtime, so normalize them to a single string before use (e.g. passing to
 * drizzle's `eq()`).
 */
export function str(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}
