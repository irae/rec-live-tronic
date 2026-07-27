# Test Fixtures

## discontinuous-two-segment.ts

A synthetic MPEG-TS file with an embedded PTS discontinuity, used to test remux.ts's stream verification.

**Generation method:** Two 1-second video+audio segments generated separately via ffmpeg with `testsrc2` (32x32, 5fps video) and `anullsrc` (stereo audio), then concatenated at the byte level (mimicking this app's stop+relaunch append behavior when recording to the same file).

**Why this matters:** When ffprobe queries this file with `-show_entries stream=codec_type -of csv=p=0`, it outputs the stream list twice (once per discontinuity boundary), causing naive line-count checks to report 2 video + 2 audio streams when there is genuinely only 1 of each. ffprobe's own `nb_streams=2` and `nb_programs=1` confirm the file is structurally valid with a single logical stream set.

**Regeneration (if needed):**
```bash
ffmpeg -y -f lavfi -i 'testsrc2=duration=1:size=32x32:rate=5' \
  -f lavfi -i 'anullsrc=duration=1' \
  -c:v libx264 -c:a aac -f mpegts /tmp/segment1.ts
ffmpeg -y -f lavfi -i 'testsrc2=duration=1:size=32x32:rate=5' \
  -f lavfi -i 'anullsrc=duration=1' \
  -c:v libx264 -c:a aac -f mpegts /tmp/segment2.ts
cat /tmp/segment1.ts /tmp/segment2.ts > test/fixtures/discontinuous-two-segment.ts
```
