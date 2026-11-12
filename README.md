# Hunt Map

A personal hunting map that works offline: wind and scent cone, legal light, sun and moon, pins, and property lines with owners. Hosted with GitHub Pages.

## How updates reach the phone
1. Change the files and bump `VERSION` in `sw.js`.
2. Push to `main`. GitHub Pages redeploys within about a minute.
3. The next time the app opens with signal, it installs the new version and shows **"Hunt Map was updated · Reload."**

Your pins, parcel files, and saved map tiles are stored on the phone, never in this repo, and they carry over between versions.
Don't commit parcel files or personal data here.
