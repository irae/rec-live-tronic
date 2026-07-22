export type UtcInstant = string | Date;

export function toUnixMilliseconds(value: UtcInstant, field: string): number {
  if (typeof value === "string" && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new TypeError(`${field} must include a UTC offset`);
  }
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isSafeInteger(milliseconds)) throw new TypeError(`${field} must be a valid UTC instant`);
  return milliseconds;
}

export function toRfc3339(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds)) throw new TypeError("Stored timestamp is not a valid UTC instant");
  return new Date(milliseconds).toISOString();
}
