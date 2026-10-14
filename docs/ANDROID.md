# Android app

The Android app is a thin shell around the UniHub web pages. It opens the
user's own server in a WebView, so its screens always match the server's
version and every feature is written once in `src/`. Native code only covers
what a browser tab cannot do. Each server image carries the matching app and
offers it for download; there is no app store.

Status (0.21.0): the app connects to a server and shows UniHub. Notifications
are not in the app yet (Web Push does not reach a WebView); they come in a later
release. Until then, keep the web app or a browser for notifications.

## Getting the app

- **Install card.** On an Android phone, UniHub's install card offers the
  **Android app** next to the **Web app** (where the browser can install it).
  Choosing the Android app shows **Download** and three steps: open the file,
  allow the browser to install apps if Android asks, then come back and tap
  **Open in app**. The app needs Android 10 or newer; phones that report an
  older version are not offered it. On a computer the card offers only the web
  app, as before.
- **Settings → General → Install** offers the same at any time. On a computer it
  links the download and says to open UniHub on the phone.
- Downloading counts as installing: the card stops appearing in that browser.
  **Later**, **No** and the once-a-day rule work as described in
  [PWA](PWA.md#install-prompt).

## Connecting to a server

- **Open in app** opens `unihub://connect?server=<this server>`. Because any
  website could send such a link, the app asks before switching to a server it
  is not already using. Without the app installed, the link downloads it.
- Opening the app directly shows a connect screen. The address is checked
  against `GET /api/version` (below) before it is saved. HTTPS is required;
  plain HTTP only works for `localhost`, `127.0.0.1` and the emulator's
  `10.0.2.2` (development).
- You sign in inside the app as in the browser, including two-factor codes.
  The app has its own session, separate from the phone's browser, which lasts
  like any device's: 21 days from the last use.
- If the server cannot be reached, the app offers **Retry** and **Change
  server**. Inside the app, Settings → General → App shows the app version,
  the server, an update when the server carries a newer app, and **Change
  server**.

## What the app does natively

`src/lib/platform.ts` is the only place in the web code that knows about the
app. The app adds `UniHubAndroid/<version> (<code>)` to the user agent and gives
the server's own top-level page (not other sites, not frames such as displayed
email) a `UniHubAndroid` object that takes JSON messages:

| Message | What the app does |
| --- | --- |
| `saveFileStart`, `saveFileChunk`, `saveFileEnd`, `saveFileAbort` | Saves a file the page made (an attachment, an export, a recording) to Downloads, in pieces of 1.5 MB that the app confirms one by one. A WebView cannot download `blob:` links. |
| `download` | Downloads a file the server streams (backups, attachments, the app update) with Android's download manager and the app's session. Only the server's own addresses. |
| `changeServer` | Forgets the server and shows the connect screen. |
| `theme` | Colours the status and navigation bars like the page (UniHub's own light/dark setting, not the phone's). |

Links to other sites, `mailto:` and `tel:` open in the matching phone app. File
inputs open Android's file picker. Recordings ask for the microphone through
Android's permission prompt.

## Version handshake

`GET /api/version` is public, so the app can recognize a server before signing
in:

```json
{ "app": "unihub", "server": "0.21.0", "protocol": 1, "minApp": "0.21.0", "features": [],
  "android": { "url": "/downloads/unihub.apk", "versionName": "0.21.0", "versionCode": 21000, "size": 117323, "sha256": "…" } }
```

`android` is `null` when the image was built without the app. Rules for
changing the handshake are in `api/src/services/app-version.ts`: add features
instead of raising the protocol, and remove something only after `minApp` has
moved past every app that uses it. The app's version follows the server's:
0.21.0 is version code 21000.

## Building

The Dockerfile's `android-1` stage builds the APK with the Android SDK
and Gradle (`android/scripts/build-apk.sh`) and copies it to
`/app/downloads/unihub.apk`; Nginx serves it at `/downloads/unihub.apk`. Build
an image without the app with `--build-arg UNIHUB_ANDROID=0`; the page then
offers only the web app.

Android's build tools run only on x86-64 Linux, so this stage always builds as
`linux/amd64`. On an ARM machine (Apple silicon, a Raspberry Pi) Docker needs
x86-64 emulation: Docker Desktop has it; on Linux install it once with
`docker run --privileged --rm tonistiigi/binfmt --install amd64`. Images built
without the app need no emulation.

### Signing key

Android installs an update only when it is signed with the same key as the
installed app. Losing the key means every user must uninstall the app, and lose
its local data, to get the next version. Back it up like the database
encryption key.

- **Official images** are signed with the key in the repository secrets
  `ANDROID_KEYSTORE_BASE64` and `ANDROID_KEYSTORE_PASSWORD`. CI refuses to
  publish an image without them. Create the key once:

  ```sh
  keytool -genkeypair -keystore unihub-release.jks -alias unihub \
    -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=UniHub"
  base64 -w0 unihub-release.jks   # the value of ANDROID_KEYSTORE_BASE64
  ```

  Use one password for the keystore and the key; it is
  `ANDROID_KEYSTORE_PASSWORD`. A PKCS12 file works as well
  (`openssl pkcs12 -export -name unihub`, alias `unihub`). Keep the key file
  out of the repository.
- **Images built without a key** (pull requests from forks, local builds) get a
  throwaway key. Such an app cannot be updated from another image: uninstall
  it first.
- **Self-built images** can use their own key:

  ```sh
  base64 -w0 my-key.jks > /tmp/keystore.b64
  docker build --secret id=android_keystore,src=/tmp/keystore.b64 \
    --secret id=android_keystore_password,src=/tmp/keystore-password \
    --build-arg UNIHUB_ANDROID_SIGNER=my-key .
  ```

  `UNIHUB_ANDROID_SIGNER` is any name for the key; the build stops without it.
  Docker's build cache does not notice a changed secret, so use a new name
  whenever the key changes, or a cached app signed with the old key ends up in
  the image.

## Development

Develop features in the browser as usual. To try the app:

1. Open `android/` in Android Studio, or build with `cd android && ./gradlew assembleDebug`
   (needs JDK 17 and the Android SDK).
2. Start the API and `npm run dev`, then `adb reverse tcp:8080 tcp:8080` so
   the phone reaches the dev server as `localhost`, which keeps service workers
   and cookies working without certificates.
3. Connect the app to `http://localhost:8080`. In the emulator,
   `http://10.0.2.2:8080` reaches the computer as well.

Every CI run keeps the app it built under **Artifacts** (`unihub-android-app`)
for trying it on a phone without publishing an image. Runs from this
repository are signed with the release key, so that app updates an installed
one.

Debug builds allow inspecting the WebView from `chrome://inspect`. To see the
install offer in development, point `UNIHUB_DOWNLOADS_DIR` at a folder with
`unihub.apk` and `unihub-android.json` before starting the API (the Vite dev
server does not serve the file itself).

Test on real phones (at least two brands) before a release that changes the
app.
