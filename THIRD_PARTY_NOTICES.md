# Third-party notices

UniHub's PolyForm or commercial license applies to its project-owned material.
Dependencies, copied components and bundled programs keep their own licenses,
including their commercial-use permissions. A UniHub commercial agreement does
not replace or restrict those rights.

## Frontend

- `src/components/ui` includes components derived from [shadcn/ui](https://github.com/shadcn-ui/ui), copyright (c) 2023 shadcn, under MIT. The notice is preserved in `licenses/third-party/shadcn-MIT.txt`.
- Icons use [Lucide](https://lucide.dev/), under ISC, with Feather-derived portions under MIT. The installed package's original notice is preserved in `licenses/third-party/lucide-ISC.txt`.
- React, React DOM, Radix UI and the other frontend dependencies retain the licenses shipped in their npm packages. `package-lock.json` records exact package versions and source tarballs. The image build collects installed production-package license and notice files into `/app/licenses/frontend-dependency-notices.txt` alongside the compiled frontend.

## API

The API image includes unmodified dependency source and its supplied license
files below `/app/api/node_modules`. `api/package-lock.json` identifies their
versions and source tarballs. In particular, `web-push` is MPL-2.0; its source and
license remain available in that directory, with a license copy in
`licenses/third-party/web-push-MPL-2.0.txt`.

### Contact photos: sharp and libvips

Contact photos are converted with [sharp](https://github.com/lovell/sharp)
0.35.5 (Apache-2.0, license in `licenses/third-party/sharp-Apache-2.0.txt`).
npm installs its prebuilt native part for the image's platform:
`@img/sharp-linuxmusl-x64` or `-arm64` (Apache-2.0) and
`@img/sharp-libvips-linuxmusl-x64` or `-arm64` 1.3.4, which contains
[libvips](https://github.com/libvips/libvips) 8.18.7 and the libraries it
uses, under LGPL-3.0-or-later. The bundled libraries are listed with their
licenses in `licenses/third-party/sharp-libvips-libraries.md`: LGPLv3
(libvips, glib, libheif, libexif, librsvg, pango, fribidi, proxy-libintl)
and permissive licenses (BSD, MIT, zlib, libpng, libtiff, IJG, fontconfig,
FreeType); cairo is used under MPL-1.1 (it is also offered under LGPL-2.1).
aom comes with the [Alliance for Open Media Patent License
1.0](https://aomedia.org/license/patent-license/). None of them is GPL or AGPL.

These libraries form one shared object (`libvips-cpp.so`) that sharp loads
at run time, unmodified, in
`/app/api/node_modules/@img/sharp-libvips-linuxmusl-*/lib`. Under the LGPL
you may replace it with your own build of the same interface. Source and
build instructions:

- [sharp 0.35.5 source](https://github.com/lovell/sharp/tree/51a990faa26ade5586a4934ac9673c98d8893326).
- [sharp-libvips 1.3.4 build scripts](https://github.com/lovell/sharp-libvips/tree/ebb95f8add54eee8bed840e3fb587e4cbec857d7): `versions.properties` names each library's version, and the build scripts download, patch and compile them.
- [libvips 8.18.7 source](https://github.com/libvips/libvips/releases/tag/v8.18.7).

The LGPL-3.0 and GPL-3.0 texts are in `licenses/third-party`.

## Container programs

The image includes Node.js, Nginx, MySQL/MariaDB client tools, FFmpeg and other
Alpine packages. These are separate components with their respective licenses.
The build records installed package versions in `/app/licenses/alpine-packages.txt`
and FFmpeg's own license report in `/app/licenses/ffmpeg-license.txt`.

The 0.10 release build uses Alpine 3.24 and FFmpeg 8.1.2-r0. That FFmpeg binary is
built with `--enable-gpl` and `--enable-version3`, including x264/x265 support;
its GPL terms apply independently of UniHub's license. UniHub invokes FFmpeg as
a separate process for recording conversion and to decode HEIC/HEIF contact photos. GPL and LGPL texts are preserved
under `licenses/third-party` and copied into the image.

Source and build information for those binaries is available separately:

- [FFmpeg 8.1.2 source](https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz) and [FFmpeg legal information](https://ffmpeg.org/legal.html).
- [Alpine 3.24 FFmpeg build recipe and patches](https://gitlab.alpinelinux.org/alpine/aports/-/tree/3.24-stable/community/ffmpeg). Its `source` entries identify the upstream source and applied patches.
- [Alpine package catalog](https://pkgs.alpinelinux.org/packages?branch=v3.24) and [Alpine 3.24 build recipes](https://gitlab.alpinelinux.org/alpine/aports/-/tree/3.24-stable). Match the installed package/version and follow its origin package's recipe for source archives, patches and build instructions, including codec libraries and the MariaDB client.
- [Node.js source releases](https://nodejs.org/download/release/) and the [official Node image build sources](https://github.com/nodejs/docker-node).

When redistributing an image or modified dependency, retain the applicable
notices and provide corresponding source and build information wherever that
component's license requires it. The project license is not a substitute for
those distribution obligations.
