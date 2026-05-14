# Recordings Technical Documentation

## Overview

The recordings feature lets users record audio in the browser or import audio
files, then store them in UniHub with metadata and tags.

Frontend capabilities:

- microphone recording through `MediaRecorder`
- pause/resume while recording
- local playback before upload
- import existing audio files
- optional client-side MP3 export using `lamejs`
- tags, search, edit, delete, download

Backend capabilities:

- chunked uploads
- resumable offset validation within one upload session
- file streaming
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

## Upload Protocol

### 1. Start Upload

`POST /api/recordings/uploads/start`

Example payload:

```json
{
  "title": "Meeting notes",
  "description": "Sprint planning",
  "original_filename": "meeting.webm",
  "content_type": "audio/webm",
  "total_bytes": 1048576,
  "duration_seconds": 300.5,
  "source": "recorded",
  "tags": ["work", "planning"]
}
```

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
  "data_base64": "..."
}
```

The server requires `offset` to match the current `bytes_received`. Incorrect
offsets return 409, which prevents accidental out-of-order writes.

### 3. Complete Upload

`POST /api/recordings/uploads/:id/complete`

The server verifies:

- uploaded bytes match declared total
- temp file size matches declared total
- temp path is under the recordings root

It then moves the file into the final user directory, inserts the recording row,
links tags, and deletes the upload row in one transaction.

## API Endpoints

All endpoints require authentication. Write endpoints require CSRF.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/recordings` | List recordings |
| POST | `/api/recordings/uploads/start` | Create upload session |
| POST | `/api/recordings/uploads/:id/chunk` | Append base64 chunk |
| POST | `/api/recordings/uploads/:id/complete` | Finalize upload |
| GET | `/api/recordings/:id/file` | Stream audio file |
| PUT | `/api/recordings/:id` | Update title/description/tags |
| DELETE | `/api/recordings/:id` | Delete recording and file |

List query parameters:

| Parameter | Behavior |
| --- | --- |
| `search` | Matches title, description, or original filename |
| `tag` | Filters to recordings linked to an exact tag name |

File route query parameters:

| Parameter | Behavior |
| --- | --- |
| `download=1` | Return `Content-Disposition: attachment`; otherwise stream inline |

## Cleanup

`cleanupExpiredRecordingUploads` runs hourly from `api/src/app.js`.

It deletes up to 100 expired upload temp files per run and removes the matching
`recording_uploads` rows.

Recording files are also deleted when:

- a recording is deleted
- all recordings are cleared from settings
- the user account is deleted

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
- Chunk upload state is stored in MySQL, but partial uploads expire after 24 hours.
