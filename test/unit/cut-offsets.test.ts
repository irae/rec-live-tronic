import t from "tap";
import { formatOffset, parseOffset } from "../../src/recordings/cut-offsets.js";

t.test("parses H:MM:SS, MM:SS, SS and fractional-second offsets", (t) => {
  t.equal(parseOffset("1:23:45"), 1 * 3600 + 23 * 60 + 45);
  t.equal(parseOffset("14:36"), 14 * 60 + 36);
  t.equal(parseOffset("45"), 45);
  t.equal(parseOffset("0:00:00.5"), 0.5);
  t.equal(parseOffset("1:02:03.25"), 3600 + 120 + 3.25);
  t.end();
});

t.test("formats seconds back to a normalized H:MM:SS string", (t) => {
  t.equal(formatOffset(45), "0:00:45");
  t.equal(formatOffset(14 * 60 + 36), "0:14:36");
  t.equal(formatOffset(3600 + 23 * 60 + 45), "1:23:45");
  t.equal(formatOffset(0.5), "0:00:00.500");
  t.end();
});

t.test("rejects malformed offset strings", (t) => {
  t.throws(() => parseOffset(""), RangeError);
  t.throws(() => parseOffset("abc"), RangeError);
  t.throws(() => parseOffset("1:2:3:4"), RangeError);
  t.throws(() => parseOffset("1:60:00"), RangeError);
  t.throws(() => parseOffset("1:00:60"), RangeError);
  t.throws(() => parseOffset("-5"), RangeError);
  t.end();
});
