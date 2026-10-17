# Study group video guides

`study-group-guide-20261017.mp4` is the owner's approved `GUIDE 1.mov`,
published for representatives and appointed deputies in the Guides tab.

- Full recording: 6 minutes 13 seconds, 1920×1080, 24 fps.
- Web version: H.264 / AAC, MP4 fast start, metadata stripped.
- The WebP poster is a frame at 8 seconds from that recording.
- Vite emits hashed assets served directly by the site's CDN. No database reads,
  signed URL expiry, extra storage permissions or external video embed are needed.
- The inline player has controls, supports fullscreen, and uses `preload="none"`.
  Merely opening a group or another tab does not download the video.

Add subsequent owner-approved videos to `src/lib/studyGroupVideoGuides.ts`.
