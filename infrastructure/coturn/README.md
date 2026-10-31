# infrastructure/coturn — REMOVED (never wired in; now fully obsolete)

This directory used to hold a `turnserver.conf` template for an optional,
never-wired-in standalone TURN server (it was not used by LiveKit's own
TURN even before this migration — see the calling architecture docs).

Media/SFU/TURN now run on **LiveKit Cloud**, which provides its own managed
TURN. There is no reason to run coturn in this deployment.
