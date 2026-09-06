# Mertz Invitational Draft Party

A public, account-free video call for the entire league. Opening the site immediately requests camera and microphone access, then automatically joins the one shared party. No lobby, accounts, or room links.

- Responsive graphite-and-lime video cards, warm gold accents, animated branding, joining/leaving transitions, and reduced-motion support.
- Native WebRTC audio and video, with a small same-origin WebSocket signaling server.
- Mute, camera power-off, independent screen sharing, participant count, session timer, and leave/rejoin.
- Live participant state, reconnect with fresh peer connections, ICE retries, permission recovery, and an audio-unlock control for browser autoplay restrictions.
- System fonts, no front-end framework, no analytics, no recording, and one production dependency (`ws`).

## Run locally

Use Node.js 22 or newer:

```sh
npm ci
npm start
```

Open http://localhost:3000 in two browser windows. Localhost is permitted for camera access. Other devices need the publicly deployed **HTTPS** URL; ordinary LAN HTTP URLs cannot request camera/microphone access.

## Deploy the public website

**GitHub stores the source; GitHub Pages cannot run the signaling server.** Deploy this repository as one Node web service with WebSocket support. The service serves both the site and `/signal`, so everyone visiting the same deployment joins the same call.

[Deploy to Render](https://render.com/deploy?repo=https://github.com/Captainkoala72/mertzfantasydraftparty)

The included `render.yaml` configures `npm ci --omit=dev`, `npm start`, Node 22, and `/health`. Use the button, connect this repository in your Render account, and create the Blueprint. Once deployment succeeds, share its `https://…onrender.com` URL. This action requires your hosting account; committing this file alone does not create a live service. Free services may sleep when idle, so allow startup time or choose an always-on plan for draft night.

Alternatively, build the Dockerfile and expose port 3000 through an HTTPS reverse proxy that forwards WebSocket upgrades. Keep **one running instance**: signaling/presence lives in memory. Horizontal replicas would split the shared party; use a shared signaling store or an SFU before scaling out.

## TURN for reliable connections

STUN is enabled by default. Direct connections work on many networks, but some cellular, corporate, VPN, and symmetric-NAT networks require a TURN relay. For a reliable public party, configure TURN before inviting the league.

For a coturn-compatible shared secret, set these **server environment variables in the hosting dashboard**, never in Git:

- `TURN_URLS`: comma-separated `turn:`/`turns:` relay URLs; include TCP/TLS transport for restrictive networks.
- `TURN_SECRET`: the relay's shared authentication secret.

The server issues time-limited HMAC TURN credentials at `/api/config`. The signing secret never reaches the browser. Credentials last 24 hours, covering a draft session.

A provider's ICE server array can instead be supplied with `ICE_SERVERS_JSON` (see `.env.example`). Browser TURN credentials must be delivered to participants; prefer short-lived credentials. Configure relay quotas, traffic limits, and credential expiry with the provider because this is a public call with no login.

Optional `PUBLIC_ORIGIN` pins the allowed HTTPS origin. Without it, WebSockets require the request's Origin host to match the Host header. Optional `MAX_PARTICIPANTS` defaults to 24 as a resource guard. WebRTC uses a full mesh, sending a copy of each track to each participant; actual capacity depends on upload bandwidth and devices. This is intended for a fantasy league, not a large broadcast. Larger events need an SFU. Screen sharing adds another outgoing video stream per participant.

## Behavior and limits

- Visitors receive an automatic anonymous `Manager XXXX` label; no identifying setup is required.
- Denied or missing media falls back to microphone-only or listen-only joining. Browser site settings may need to be changed before enabling blocked devices.
- Camera off stops the camera track and releases the device. Muting disables the microphone track. Leaving stops all local tracks, closes connections, and removes presence.
- Screens are shared separately from the camera, so sharing does not hide the person. Screen capture requires a click and browser selection. Mobile browsers may not support it; the control explains when unavailable. System/tab audio sharing is intentionally not included; the microphone continues normally.
- A browser may require a click before playing participant audio. An “Enable audio” button appears when playback is blocked.
- A temporary signaling outage triggers automatic rejoining. Peer media failures trigger ICE restart attempts. Dead WebSockets are removed by heartbeat within about 30 seconds.
- The site does not record or persist media, participant names, or call history. WebRTC encrypts media in transit. This is a public call: anyone with the URL can join, and participants can independently record using their own software.
- Server restarts clear presence. Active visitors reconnect automatically.

## Validation

```sh
npm run check
npm test
```

The integration tests use real WebSocket clients to verify shared-party discovery, state updates, targeted signaling, unspoofable sender IDs, leaving/rejoining, capacity handling, origin rejection, malformed messages, and health/static endpoints.

Before the live event, validate on two real devices and different networks: camera/mic permissions, two-way audio/video, camera toggle, screen sharing and browser stop-share, leave/rejoin, and network recovery. Server tests do not substitute for real device WebRTC testing; TURN connectivity and browser capture require a live HTTPS deployment.

References: [WebRTC signaling](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling), [screen capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia), [Render Blueprint specification](https://render.com/docs/blueprint-spec).
