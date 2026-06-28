Place the following binary assets in this folder before packaging:

  ffmpeg.exe       Static FFmpeg build (optional — see note below).
                   Download: https://www.gyan.dev/ffmpeg/builds/
                             -> ffmpeg-release-essentials.zip -> bin/ffmpeg.exe
  icon.ico         Application icon (256x256 recommended).
  tray-icon.ico    System-tray icon (16x16 / 32x32).

The app runs without these (it falls back to an empty tray icon and the default
window icon). They only matter for a polished packaged build.

NOTE ON ffmpeg / H.264:
LANDesk currently streams JPEG frames for all quality tiers because the renderer
decodes each frame with an HTML <img>, which cannot decode raw H.264/MPEG-TS.
ffmpeg.exe is therefore not required at runtime today; it is reserved for a
future hardware-encoded path. You can ship without it.
