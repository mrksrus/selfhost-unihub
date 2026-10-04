# Recordings Technical Documentation

## Overview

The recordings feature lets users record audio in the browser or import audio
files, then store them in UniHub with metadata and tags.

Frontend capabilities:

- mono 16-bit PCM WAV microphone recording through `AudioWorklet`, with the
  browser's automatic gain control, noise suppression and echo cancellation off
- pause/resume while recording
- recordings kept on the device until the server has them, with crash recovery
- uploads that continue after the app is closed, or a notification when they cannot
- local playback before upload
- import existing audio files
- original-format playback and server-side MP3 export
- tags, search, edit, delete, download
- optional category, explicit recorded date, and manual Music chords

Backend capabilities:

- chunked uploads
- resumable offset validation within one upload session
- optional SHA-256 upload integrity verification
- MP3 conversion through `ffmpeg`
- byte-range file streaming
- tag normalization/linking
- expired temporary upload cleanup

## Storage

Filesystem root:

```text
/app/uploads/recordings
```

Final files are stored below:

```text
/app/uploads/recordings/<userId>/<recordingId>.<ext>
```

Temporary upload files are stored below:

```text
/app/uploads/recordings/.tmp/<userId>/<uploadId>.part
```

Database tables:

| Table | Purpose |
| --- | --- |
| `recordings` | Audio metadata and final storage path |
| `recording_tags` | Per-user tag catalog |
| `recording_tag_links` | Recording-to-tag join table |
| `recording_uploads` | In-progress chunked uploads |
| `recording_transcription_jobs` | Reserved schema for transcription jobs |

Recording category values are `none`, `music`, `journal`, `memory`, and
`reminder`. The generic `metadata` JSON object is reserved for category-specific
fields; V1 uses `metadata.chords` for Music recordings.

## Limits

| Limit | Value |
| --- | --- |
| Max recording size | 500 MB |
| Max decoded chunk size | 768 KB |
| Frontend upload chunk size | 512 KB |
| Upload TTL | 24 hours |
| Max tags per recording | 20 |
| Max tag length | 80 characters |
| Max title length | 255 characters |
| Max description length | 5000 characters |
| Concurrent MP3 conversions | 1 per app container |
| Waiting MP3 conversions | 4 total; 2 active/waiting requests per user |
| MP3 queue wait | 60 seconds, then retry response |
| MP3 conversion deadline | 15 minutes |
| MP3 output ceiling | 500 MiB |

New microphone recordings use uncompressed mono WAV at the browser audio
context's sample rate, normally 44.1 or 48 kHz. Storage use is approximately
5-6 MB per minute.

Capture uses the microphone's reported sample rate where available and batches
4,096 samples per worklet message. Pause and stop flush the remaining samples.
This reduces browser messaging and avoids forcing a 44.1 kHz conversion. The
recording timer updates once per second. These changes reduce overhead; actual
microphone quality still depends on the browser, device and audio drivers.

Saving and normal playback use the original audio. The player offers **Try MP3
playback** only if original playback fails, and conversion starts only when the
user selects it. MP3 exports are cached and never replace the original. Encoding
and decoding each use one thread; the bounded conversion queue prevents several
exports from competing for CPU at once. Busy or expired queue requests return
HTTP 429 so the user can retry.

## Upload Protocol

### 1. Start Upload

`POST /api/recordings/uploads/start`

Example payload:

```json
{
  "title": "Meeting notes",
  "description": "Sprint planning",
  "original_filename": "meeting.wav",
  "content_type": "audio/wav",
  "total_bytes": 1048576,
  "duration_seconds": 300.5,
  "source": "recorded",
  "tags": ["work", "planning"],
  "upload_id": "optional lowercase UUID chosen by the client"
}
```

With `upload_id`, start can be repeated safely: the same ID resumes the
existing upload (409 if `total_bytes` differs, 410 once it expired), and an ID
that already became a recording answers `{ "completed": true, "recording": … }`.
The browser uses the ID of the recording kept on the device, so an upload whose
start answer was lost never leaves a second upload behind. Without `upload_id`
the server picks a random one.

Response includes:

- upload ID
- `bytes_received`
- `total_bytes`
- `max_chunk_bytes`
- `expires_at`

### 2. Upload Chunks

`POST /api/recordings/uploads/:id/chunk`

Payload:

```json
{
  "offset": 0,
  "data_base64": "...",
  "sha256": "optional-64-character-hex-checksum-of-this-chunk"
}
```

The server requires `offset` to match the current `bytes_received`. Incorrect
offsets return 409, which prevents accidental out-of-order writes.
If provided, the chunk checksum must match before any bytes are appended. The
browser reads and hashes one 512 KiB slice at a time, avoiding full-file buffer
copies. The older optional whole-upload checksum remains supported.

### 3. Complete Upload

`POST /api/recordings/uploads/:id/complete`

The server verifies:

- uploaded bytes match declared total
- temp file size matches declared total
- temp path is under the recordings root
- file signature identifies supported WAV, MP3, M4A/MP4, Ogg, WebM, FLAC, AAC or AIFF

It verifies the optional SHA-256 checksum, then moves the original file into the
final user directory. A database transaction inserts the recording row, links
tags, and deletes the upload row. If that transaction fails, the error handler
removes the moved file; the filesystem move itself is not transactional. Browser
microphone recordings and imported files both retain their original bytes and
format.
Stored content type and extension come from the detected signature, not the
supplied filename or MIME type. This is format identification, not malware
scanning or a complete decode check. MP3 conversion restricts the decoder to
that detected format and disallows network input protocols.

## Recordings on the device

The browser keeps every recording in IndexedDB (`unihub-recordings-v1`) until
the server confirms it, so closing the app, a crash or a lost connection does
not lose audio. The code is in `src/lib/recording-queue.ts`,
`src/lib/recording-upload.ts`, `src/hooks/use-recording-uploads.ts` and
`src/sw/recording-uploads.ts`.

**While recording.** The `AudioWorklet` sends 16-bit samples to the page,
which writes them to IndexedDB every 2 seconds. If the tab or the browser
closes before **Stop**, the next visit to Recordings turns the written samples
into a WAV file and offers it as a draft marked *recovered*. At most the last
2 seconds are lost. A Web Lock per recording keeps other tabs from recovering
a recording that is still running.

**Volume.** Phones and laptops apply automatic gain control to microphones by
default. On music this makes the volume swell and fade. UniHub asks for gain
control, noise suppression and echo cancellation to be off, checks what the
browser actually applied and warns when one is still on. The WAV file is the
unmodified signal; nothing is compressed or resampled after capture.

**After Stop.** The recording is a draft on the device, listed under **On
this device** with Continue, Download and Discard. **Save** queues it. The
queue uploads one recording at a time, oldest first, in 512 KiB chunks, each
with its SHA-256. The server checks every chunk, then the file signature, so a
recording arrives byte for byte or not at all. The recording is deleted from
the device only after the server has stored it. Rejected files (for example too
large) stay on the device as *failed*, with Try again and Download.

**Discard.** Every recording on the device can be discarded, also one that is
still waiting to upload. For a waiting recording the page stops its own upload,
waits up to 30 seconds for the upload lock (another tab or the service worker
may be sending a chunk), and cancels the server's partial upload. Only then is
the audio deleted on the device. If the upload finished in the meantime, the
page says so instead: the recording is in the library and can be deleted
there. If the server cannot be reached, the dialog asks again with **Discard
anyway**; the partial upload is then removed on the server when it expires.
Browsers without Web Locks cannot keep other uploaders away, so they offer
Discard only for drafts and refused files.

**Who uploads.** One uploader at a time, guarded by the Web Lock
`unihub-recording-uploads`:

1. The open page uploads while it is visible, and retries with backoff (15
   seconds up to 5 minutes) after network or server errors.
2. When the page is hidden or closed it hands the queue to the service worker.
   With Background Sync (Chrome, Edge, Android) the browser wakes the worker
   when there is a connection, even after the app is closed, and retries with
   backoff. Without it (Safari, Firefox) the worker gets a short time after the
   page hides.
3. If the worker cannot finish, it shows **Recording not uploaded yet**, or
   **Sign in to finish uploading** when the session ended. Background Sync's
   last attempt does the same. A recording the server refused gets **Recording
   could not be uploaded**; it names the recording only after the worker has
   checked, in the same queue as sign-out, that its account is still the one
   signed in on the device.
4. If the browser stops the worker before it can say so (iOS does this), the
   server notices: an upload that has not moved for 10 minutes sends the push
   notification **Recording not uploaded yet** with the percentage reached.
   It uses the same notification tag as the device's notice, so the user sees
   one notice per recording, and it is dropped if the upload moved on. It is
   not sent while Recordings is disabled, and waits while a restore of
   recordings is running.

The service worker sends `X-Background-Sync: 1` instead of the CSRF token,
which it cannot read. The server accepts that header only for the upload start,
chunk, complete and cancel routes. Notifications need notification permission
(Settings → Notifications); without it, the recording still waits on the device
and uploads the next time UniHub is open.

Recordings belong to the account that made them. A queued recording of another
account waits until that account signs in on the device again. Signing out does
not delete recordings kept on the device.

## API Endpoints

All endpoints require authentication. Write endpoints require CSRF.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/recordings` | List recordings |
| POST | `/api/recordings/uploads/start` | Create or resume upload session |
| GET | `/api/recordings/uploads/:id` | Upload progress |
| POST | `/api/recordings/uploads/:id/chunk` | Append base64 chunk |
| POST | `/api/recordings/uploads/:id/complete` | Finalize upload (repeatable) |
| DELETE | `/api/recordings/uploads/:id` | Cancel upload and remove its temp file |
| GET | `/api/recordings/:id/file` | Stream audio file |
| PUT | `/api/recordings/:id` | Update title/description/tags |
| DELETE | `/api/recordings/:id` | Delete recording and file |

List query parameters:

| Parameter | Behavior |
| --- | --- |
| `search` | Matches title, description, original filename, or Music chords |
| `tag` | Filters to recordings linked to an exact tag name |
| `category` | Filters to one category, such as `music` |
| `music_missing_chords=true` | Filters Music recordings where `metadata.chords` is empty |

File route query parameters:

| Parameter | Behavior |
| --- | --- |
| `download=1` | Return `Content-Disposition: attachment`; otherwise stream inline |
| `format=mp3` | Return MP3 audio; files are converted and cached without deleting the original |

## Cleanup

`cleanupExpiredRecordingUploads` runs hourly from `api/src/app.js`.

It deletes up to 100 expired upload temp files per run and removes the matching
`recording_uploads` rows.

Recording files are also deleted when:

- a recording is deleted
- all recordings are cleared from settings
- the user account is deleted

## Backup and Restore

Recording backups include recording metadata, original stored files, tags, and
tag links. Validation requires every declared recording file to exist and match
its SHA-256 checksum.
Restore additionally checks the audio signature before storing a canonical
audio content type. Unsupported files reject the restore transaction.

Restore matches recordings by ID, file checksum, or normalized title/date/size.
Tags match by normalized name, and links are remapped to the restored recording
and tag IDs. Keep both creates a new recording ID while preserving its tags.

Files are copied into a restore-job-specific directory and removed if the
database transaction fails or the job is cancelled.

See [Backup and Restore Guide](BACKUP_RESTORE.md).

## Security Notes

- All routes are scoped by `user_id`.
- Final and temp file paths are checked to stay under the recordings root.
- Chunk upload rejects oversized chunks and mismatched offsets.
- Listing and streaming never expose raw filesystem paths.

## Limitations

- Transcription job schema exists, but no transcription worker/provider flow is implemented.
- There is no malware scanning.
- There is no per-user storage quota beyond per-recording size limits.
- Browser recording support depends on the user's browser and device permissions.
- Browser recording requires `AudioWorklet`, available in modern secure-context browsers.
- Chunk upload state is stored in MariaDB, but partial uploads expire after 24 hours.
- The production image includes `ffmpeg`; local API development also requires it
  for MP3 export.
